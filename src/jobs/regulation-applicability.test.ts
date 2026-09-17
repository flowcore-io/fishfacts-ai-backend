import { describe, expect, test } from "bun:test";
import type { Env } from "@/env";
import type { RegulationRevisionProposed } from "@/events/contracts";
import type { PathwayWriter } from "@/pathways";
import type {
  ApplicabilityCandidateCase,
  RegulationQueueRepository,
} from "@/regulations/queue-repository";
import {
  APPLICABILITY_ACTOR,
  type ApplicabilityRunResult,
  createRegulationApplicabilityJob,
} from "./regulation-applicability";

const env = { LOGASAVN_WORKSPACE_ID: "ws-logasavn" } as Env;

const SOURCE = "Det er forbudt å fiske med torsketrål på Røstbanken.";

const ANSWER = JSON.stringify({
  gear: ["torsketrål"],
  activity: "prohibited",
  evidence: {
    gear: "fiske med torsketrål",
    activity: "Det er forbudt å fiske",
  },
  notes: "Ingen lengdegrense oppgitt.",
});

function candidate(
  overrides: Partial<ApplicabilityCandidateCase> = {},
): ApplicabilityCandidateCase {
  return {
    caseId: "00000000-0000-4000-8000-0000000000c1",
    caseKey: "fiskeridir-jmelding:J-39-2026",
    title: "J-39-2026 Røstbanken",
    jurisdiction: "NO",
    currentRevisionId: "00000000-0000-4000-8000-00000000000a",
    snapshotText: SOURCE,
    snapshotFragmentId: null,
    fields: {
      title: "J-39-2026 Røstbanken",
      authority: "Fiskeridirektoratet",
      regulationNumber: null,
      category: "closure",
      summary: null,
      effectiveFrom: null,
      effectiveTo: null,
      expiresAt: null,
      seasonalRecurrence: null,
      interpretationNotes: null,
      applicability: null,
    },
    ...overrides,
  };
}

function harness(options: {
  cases: ApplicabilityCandidateCase[];
  answer?: string | Error;
  /** undefined = fragment gone (404/null); "" = unreadable (transient). */
  fragmentBody?: string;
  /** Simulates the projector refusing the proposal (stale base). */
  pointerStaysPut?: boolean;
  /** Simulates the pathways wait giving up on a durable write. */
  projectionPending?: boolean;
  /** Reads of the case pointer before the proposal shows up. */
  pointerLandsAfterReads?: number;
}) {
  const written: RegulationRevisionProposed[] = [];
  const prompts: string[] = [];
  const writer = {
    writeRegulationRevisionProposedDetailed: async (
      data: RegulationRevisionProposed,
    ) => {
      written.push(data);
      return {
        eventId: "event-1",
        projectionPending: options.projectionPending ?? false,
      };
    },
  } as never as PathwayWriter;
  let pointerReads = 0;
  const usable = {
    getFragmentById: async () =>
      options.fragmentBody === undefined
        ? null
        : { id: "frag-1", content: options.fragmentBody, title: "t" },
  };
  const queue = {
    listApplicabilityCandidates: async () => options.cases,
    listRevisionGeometries: async () => [],
    getCurrentRevisionId: async (caseId: string) => {
      pointerReads += 1;
      const base =
        options.cases.find((entry) => entry.caseId === caseId)
          ?.currentRevisionId ?? null;
      if (options.pointerStaysPut) return base;
      // The projection lands after N reads — the slow-but-successful case.
      if (pointerReads <= (options.pointerLandsAfterReads ?? 0)) return base;
      return (
        written.find((event) => event.caseId === caseId)?.revisionId ?? null
      );
    },
  } as never as RegulationQueueRepository;
  const chat = async (messages: Array<{ role: string; content: string }>) => {
    prompts.push(messages[0]?.content ?? "");
    if (options.answer instanceof Error) throw options.answer;
    return { text: options.answer ?? ANSWER, model: "test-model" };
  };
  const run = createRegulationApplicabilityJob(
    env,
    writer,
    usable,
    queue,
    chat,
    {
      intervalMs: 1,
      timeoutMs: 40,
    },
  );
  const context = {
    signal: new AbortController().signal,
    isStopRequested: () => false,
    reportProgress: () => {},
  };
  return { written, prompts, run, context, reads: () => pointerReads };
}

const resultOf = (message: string) =>
  JSON.parse(message) as ApplicabilityRunResult;

describe("regulation-applicability job", () => {
  test("a quoted answer becomes a revision that changes only applicability", async () => {
    const { written, run, context } = harness({ cases: [candidate()] });
    const result = resultOf((await run(undefined, {}, context)).message);

    expect(written).toHaveLength(1);
    const event = written[0];
    if (!event) return;
    expect(event.changes).toHaveLength(1);
    expect(event.changes[0]?.field).toBe("applicability");
    expect(event.changes[0]?.justification).toContain("gear");
    expect(event.actor).toBe(APPLICABILITY_ACTOR);
    expect(event.baseRevisionId).toBe(candidate().currentRevisionId);
    expect(event.fields).toEqual({
      ...candidate().fields,
      applicability: event.fields.applicability,
    });
    expect(event.fields.applicability?.gear).toEqual(["torsketrål"]);
    expect(event.fields.applicability?.evidence?.gear).toBe(
      "fiske med torsketrål",
    );
    expect(result.proposed).toEqual([
      {
        caseKey: candidate().caseKey,
        title: candidate().title,
        revisionId: event.revisionId,
      },
    ]);
    expect(result.failed).toEqual([]);
  });

  test("a rule-less answer still proposes — a note and no dimension", async () => {
    const { written, run, context } = harness({
      cases: [candidate()],
      answer: JSON.stringify({ notes: "Teksten oppgir ingen avgrensing." }),
    });
    const result = resultOf((await run(undefined, {}, context)).message);
    expect(result.failed).toEqual([]);
    expect(written[0]?.fields.applicability).toEqual({
      notes: "Teksten oppgir ingen avgrensing.",
    });
    expect(written[0]?.changes[0]?.justification).toContain("no applicability");
  });

  test("a quote that is not in the source writes nothing and names the case", async () => {
    const { written, run, context } = harness({
      cases: [candidate()],
      answer: JSON.stringify({
        gear: ["trål"],
        evidence: { gear: "fiske med trål" },
      }),
    });
    const result = resultOf((await run(undefined, {}, context)).message);
    expect(written).toHaveLength(0);
    expect(result.proposed).toEqual([]);
    expect(result.failed[0]?.caseKey).toBe(candidate().caseKey);
    expect(result.failed[0]?.reason).toBe("quote_not_in_source");
    expect(result.failed[0]?.detail).toContain("gear");
  });

  test("a case with no text and no fragment is reported, not skipped", async () => {
    const { written, run, context } = harness({
      cases: [candidate({ snapshotText: null })],
    });
    const result = resultOf((await run(undefined, {}, context)).message);
    expect(written).toHaveLength(0);
    expect(result.failed[0]?.reason).toBe("no_source_text");
    expect(result.failed[0]?.title).toBe(candidate().title);
  });

  test("a proposal the projection is still catching up on is not a refusal", async () => {
    const { written, run, context, reads } = harness({
      cases: [candidate()],
      // The pathways wait gave up; the event is durable and lands a beat later.
      projectionPending: true,
      pointerLandsAfterReads: 2,
    });
    const result = resultOf((await run(undefined, {}, context)).message);
    expect(written).toHaveLength(1);
    expect(result.failed).toEqual([]);
    expect(result.proposed[0]?.revisionId).toBe(
      written[0]?.revisionId as string,
    );
    // It had to look more than once — that is the whole point of the poll.
    expect(reads()).toBeGreaterThan(1);
  });

  test("a durable write that never lands is projection_pending, naming the revision", async () => {
    const { written, run, context, reads } = harness({
      cases: [candidate()],
      projectionPending: true,
      pointerStaysPut: true,
    });
    const result = resultOf((await run(undefined, {}, context)).message);
    expect(result.proposed).toEqual([]);
    expect(result.failed[0]?.reason).toBe("projection_pending");
    expect(result.failed[0]?.detail).toContain(
      written[0]?.revisionId as string,
    );
    expect(reads()).toBeGreaterThan(1);
  });

  test("a gone fragment is durable (no_source_text), an unreadable one transient", async () => {
    const gone = harness({
      cases: [candidate({ snapshotText: null, snapshotFragmentId: "frag-1" })],
    });
    const goneResult = resultOf(
      (await gone.run(undefined, {}, gone.context)).message,
    );
    expect(goneResult.failed[0]?.reason).toBe("no_source_text");
    expect(goneResult.failed[0]?.detail).toContain("frag-1");

    const unreadable = harness({
      cases: [candidate({ snapshotText: null, snapshotFragmentId: "frag-1" })],
      fragmentBody: "",
    });
    const unreadableResult = resultOf(
      (await unreadable.run(undefined, {}, unreadable.context)).message,
    );
    expect(unreadableResult.failed[0]?.reason).toBe("source_unreadable");
    expect(unreadableResult.failed[0]?.detail).toContain("without content");
  });

  test("a transport error writes no event and does not stop the run", async () => {
    const { written, run, context } = harness({
      cases: [
        candidate(),
        candidate({ caseId: "00000000-0000-4000-8000-0000000000c2" }),
      ],
      answer: new Error("Embed chat answered 503"),
    });
    const result = resultOf((await run(undefined, {}, context)).message);
    expect(written).toHaveLength(0);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]?.reason).toBe("chat_error");
    expect(result.failed[0]?.detail).toContain("503");
  });

  test("prose is unparseable, and nothing half-read is proposed", async () => {
    const { written, run, context } = harness({
      cases: [candidate()],
      answer: "It applies to cod trawlers.",
    });
    const result = resultOf((await run(undefined, {}, context)).message);
    expect(written).toHaveLength(0);
    expect(result.failed[0]?.reason).toBe("unparseable");
  });

  test("a proposal the projector refused is stale_base, settled in ONE read", async () => {
    const { written, run, context, reads } = harness({
      cases: [candidate()],
      pointerStaysPut: true,
    });
    const result = resultOf((await run(undefined, {}, context)).message);
    expect(written).toHaveLength(1);
    expect(result.proposed).toEqual([]);
    expect(result.failed[0]?.reason).toBe("stale_base");
    // The await already waited for the handler on this path, so there is
    // nothing to wait for — a bounded run must not spend its clock here.
    expect(reads()).toBe(1);
  });

  test("a dry run extracts and verifies but writes nothing", async () => {
    const { written, prompts, run, context } = harness({
      cases: [candidate()],
    });
    const execution = await run(undefined, { dryRun: true }, context);
    const result = resultOf(execution.message);
    expect(prompts).toHaveLength(1);
    expect(written).toHaveLength(0);
    expect(execution.changed).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.proposed).toEqual([
      {
        caseKey: candidate().caseKey,
        title: candidate().title,
        revisionId: null,
      },
    ]);
  });

  test("the prompt carries the case's own text and jurisdiction", async () => {
    const { prompts, run, context } = harness({ cases: [candidate()] });
    await run(undefined, {}, context);
    expect(prompts[0]).toContain(SOURCE);
    expect(prompts[0]).toContain("(NO): J-39-2026 Røstbanken");
  });
});
