import { describe, expect, test } from "bun:test";
import {
  AIS_TRACK_WINDOWS_MAX,
  type AisClickhouseRepository,
} from "../../src/ais/clickhouse-repository";
import { createAisRouter } from "../../src/ais/routes";

type Captured = { opts?: Record<string, unknown> };

function mockRepo(captured: Captured): AisClickhouseRepository {
  return {
    getTrackWindows: async (opts: Record<string, unknown>) => {
      captured.opts = opts;
      return {
        windows: (
          opts.windows as Array<{ vesselId: number; from: string; to: string }>
        ).map((w) => ({ ...w, pointCount: 0, points: [] })),
      };
    },
  } as unknown as AisClickhouseRepository;
}

async function post(
  app: ReturnType<typeof createAisRouter>,
  body: unknown,
): Promise<Response> {
  return await app.request("/tracks/windows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const TOW = {
  vesselId: 913,
  from: "2025-03-04T06:12:00.000Z",
  to: "2025-03-04T08:31:00.000Z",
};

describe("POST /tracks/windows — validation", () => {
  test("400 on a non-JSON body", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await app.request("/tracks/windows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("400 when windows is missing or empty", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    expect((await post(app, {})).status).toBe(400);
    expect((await post(app, { windows: [] })).status).toBe(400);
  });

  test("400 above the window cap, and OK at exactly the cap", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const many = (n: number) => ({
      windows: Array.from({ length: n }, () => TOW),
    });
    expect((await post(app, many(AIS_TRACK_WINDOWS_MAX + 1))).status).toBe(400);
    expect((await post(app, many(AIS_TRACK_WINDOWS_MAX))).status).toBe(200);
  });

  // The point of validating up front rather than letting ClickHouse fail: a
  // client with 300 windows can fix the one that is wrong.
  test("the message names the offending index and field", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await post(app, {
      windows: [TOW, TOW, { ...TOW, to: "the day before yesterday" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("windows[2]");
    expect(body.message).toContain("ISO-8601");
  });

  test("400 when from is after to", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await post(app, {
      windows: [{ ...TOW, from: TOW.to, to: TOW.from }],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain(
      "windows[0]",
    );
  });

  // The map really does carry these; an empty answer is honest, a 400 is not.
  test("a zero-length window is accepted", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await post(app, { windows: [{ ...TOW, to: TOW.from }] });
    expect(res.status).toBe(200);
  });

  test("400 on a negative or non-integer vesselId", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    expect((await post(app, { windows: [{ ...TOW, vesselId: -1 }] })).status).toBe(
      400,
    );
    expect(
      (await post(app, { windows: [{ ...TOW, vesselId: "MS Fram" }] })).status,
    ).toBe(400);
  });
});

describe("POST /tracks/windows — what reaches the repository", () => {
  test("windows pass through in request order, timestamps normalised", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const res = await post(app, {
      windows: [
        TOW,
        { vesselId: 14, from: "2024-01-08T00:00:00Z", to: "2024-01-08T04:00:00Z" },
        TOW,
      ],
    });
    expect(res.status).toBe(200);
    expect(captured.opts?.windows).toEqual([
      TOW,
      {
        vesselId: 14,
        from: "2024-01-08T00:00:00.000Z",
        to: "2024-01-08T04:00:00.000Z",
      },
      TOW,
    ]);
  });

  test("maxPointsPerWindow defaults, and clamps rather than rejecting", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });

    await post(app, { windows: [TOW] });
    expect(captured.opts?.maxPointsPerWindow).toBe(4000);

    await post(app, { windows: [TOW], maxPointsPerWindow: 250 });
    expect(captured.opts?.maxPointsPerWindow).toBe(250);

    await post(app, { windows: [TOW], maxPointsPerWindow: 10_000_000 });
    expect(captured.opts?.maxPointsPerWindow).toBe(50_000);
  });

  test("the speed band is forwarded only when asked for", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });

    await post(app, { windows: [TOW] });
    expect(captured.opts?.minKnots).toBeUndefined();
    expect(captured.opts?.maxKnots).toBeUndefined();

    await post(app, { windows: [TOW], minKnots: 0.3, maxKnots: 5.5 });
    expect(captured.opts?.minKnots).toBe(0.3);
    expect(captured.opts?.maxKnots).toBe(5.5);
  });

  test("400 on an inverted speed band", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await post(app, {
      windows: [TOW],
      minKnots: 5.5,
      maxKnots: 0.3,
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /tracks/windows — the response contract", () => {
  // This is the property the FE's index-matching rests on. A vessel may appear
  // in several windows and an empty window still gets its entry, so an answer
  // can never slide one tow's track onto another tow.
  test("one entry per requested window, in request order, vessels repeating", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const asked = [
      TOW,
      { vesselId: 14, from: TOW.from, to: TOW.to },
      { ...TOW, from: "2025-03-04T09:00:00.000Z", to: "2025-03-04T10:00:00.000Z" },
    ];
    const res = await post(app, { windows: asked });
    const body = (await res.json()) as {
      windows: Array<{ vesselId: number; from: string; to: string }>;
    };
    expect(body.windows).toHaveLength(asked.length);
    expect(body.windows.map((w) => w.vesselId)).toEqual([913, 14, 913]);
    expect(body.windows.map((w) => w.from)).toEqual(asked.map((w) => w.from));
  });
});
