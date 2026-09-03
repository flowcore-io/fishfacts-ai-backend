import { describe, expect, test } from "bun:test";
import type { Env } from "@/env";
import type { RegulationVerdictRecorded } from "@/events/contracts";
import type { PathwayWriter } from "@/pathways";
import type {
  PendingVerdictCase,
  RegulationQueueRepository,
} from "@/regulations/queue-repository";
import { createRegulationVerdictJob } from "./regulation-verdict";

const env = { LOGASAVN_WORKSPACE_ID: "ws-logasavn" } as Env;

function pendingCase(
  overrides: Partial<PendingVerdictCase> = {},
): PendingVerdictCase {
  return {
    caseId: "case-1",
    caseKey: "fiskeridir-jmelding:J-1-2026",
    title: "Test J-1-2026",
    jurisdiction: "NO",
    revisionId: "00000000-0000-4000-8000-00000000000a",
    contentHash: "hash-1",
    snapshotText: "Det er forbudt å fiske i testområdet.",
    snapshotFragmentId: null,
    ...overrides,
  };
}

function harness(options: {
  cases: PendingVerdictCase[];
  answer?: string | Error;
  fragmentBody?: string | null;
}) {
  const written: RegulationVerdictRecorded[] = [];
  const writer = {
    writeRegulationVerdictRecorded: async (data: RegulationVerdictRecorded) => {
      written.push(data);
      return "event-1";
    },
  } as never as PathwayWriter;
  const usable = {
    getFragmentById: async () =>
      options.fragmentBody == null
        ? null
        : { id: "frag-1", content: options.fragmentBody, title: "t" },
  };
  const queue = {
    listPendingVerdicts: async () => options.cases,
  } as never as RegulationQueueRepository;
  const chat = async () => {
    if (options.answer instanceof Error) throw options.answer;
    return { text: options.answer ?? "", model: "test-model" };
  };
  const run = createRegulationVerdictJob(env, writer, usable, queue, chat);
  const context = {
    signal: new AbortController().signal,
    isStopRequested: () => false,
    reportProgress: () => {},
  };
  return { written, run, context };
}

describe("regulation-verdict job", () => {
  test("a schema-valid answer becomes an ok verdict event", async () => {
    const { written, run, context } = harness({
      cases: [pendingCase()],
      answer: JSON.stringify({
        issues: [
          { field: "§ 1", kind: "missing_expiry", ref: null, confidence: 0.7 },
        ],
      }),
    });
    const result = await run(undefined, {}, context);
    expect(written).toHaveLength(1);
    expect(written[0]?.status).toBe("ok");
    expect(written[0]?.issues[0]?.kind).toBe("missing_expiry");
    expect(written[0]?.model).toBe("test-model");
    expect(result.changed).toBe(true);
  });

  test("an invalid answer records a FAILED verdict — fail closed, as state", async () => {
    const { written, run, context } = harness({
      cases: [pendingCase()],
      answer: "I could not find any problems with this regulation.",
    });
    await run(undefined, {}, context);
    expect(written).toHaveLength(1);
    expect(written[0]?.status).toBe("failed");
    expect(written[0]?.issues).toHaveLength(0);
    expect(written[0]?.error).toContain("not JSON");
  });

  test("a case with no source text records a failed verdict, not a retry loop", async () => {
    const { written, run, context } = harness({
      cases: [pendingCase({ snapshotText: null, snapshotFragmentId: null })],
      answer: "unused",
    });
    await run(undefined, {}, context);
    expect(written).toHaveLength(1);
    expect(written[0]?.status).toBe("failed");
    expect(written[0]?.error).toContain("no source text");
  });

  test("a transport error records NOTHING — the case stays pending", async () => {
    const { written, run, context } = harness({
      cases: [pendingCase()],
      answer: new Error("Embed chat answered 429"),
    });
    const result = await run(undefined, {}, context);
    expect(written).toHaveLength(0);
    expect(result.changed).toBe(false);
    expect(result.message).toContain("not judged (transient): 1");
  });

  test("a statute case reads its text from the corpus fragment", async () => {
    const { written, run, context } = harness({
      cases: [
        pendingCase({
          caseKey: "logasavn:LOG-K-45-2022",
          snapshotText: null,
          snapshotFragmentId: "frag-45-2022",
        }),
      ],
      fragmentBody: "# Title\n\n§ 2. Loyvt er ikki …",
      answer: JSON.stringify({
        issues: [{ field: "overall", kind: "ok", ref: null, confidence: 1 }],
      }),
    });
    await run(undefined, {}, context);
    expect(written).toHaveLength(1);
    expect(written[0]?.status).toBe("ok");
  });

  test("an unreadable fragment is transient — one case costs one case", async () => {
    const { written, run, context } = harness({
      cases: [
        pendingCase({
          snapshotText: null,
          snapshotFragmentId: "frag-gone",
        }),
        pendingCase({
          caseKey: "fiskeridir-jmelding:J-2-2026",
          revisionId: "00000000-0000-4000-8000-00000000000b",
        }),
      ],
      fragmentBody: null,
      answer: JSON.stringify({
        issues: [{ field: "overall", kind: "ok", ref: null, confidence: 1 }],
      }),
    });
    const result = await run(undefined, {}, context);
    expect(written).toHaveLength(1);
    expect(written[0]?.caseKey).toBe("fiskeridir-jmelding:J-2-2026");
    expect(result.message).toContain("not judged (transient): 1");
  });
});
