import { createHash } from "node:crypto";
import type { Env } from "@/env";
import { extractAreas } from "@/logasavn/areas";
import {
  type ComparisonResult,
  compareReading,
  ringLabel,
} from "@/logasavn/closure-reading";
import type { StatuteReading } from "@/logasavn/closure-reading";
import {
  INDEX_FRAGMENT_KEY,
  type IndexCandidate,
  parseIndexFragment,
} from "@/logasavn/index-fragment";
import type { StatuteReader } from "@/logasavn/reader";
import { hashBody } from "@/logasavn/sweep";
import type { PathwayWriter } from "@/pathways";
import { type UsableFragment, bodyFromContent } from "@/usable/client";
import type { JobExecutionResult, JobState } from "./types";

/** The slice of the Usable client this job needs, named so it can be faked. */
export type LogasavnClosuresUsable = {
  getFragmentByKey(
    workspaceId: string,
    key: string,
  ): Promise<UsableFragment | null>;
  getFragmentById(
    fragmentId: string,
    workspaceId: string,
  ): Promise<UsableFragment | null>;
};

type Context = {
  signal: AbortSignal;
  isStopRequested: () => boolean;
  reportProgress: (progress: {
    phase: string;
    message?: string;
    itemsDiscovered?: number;
    detailsProcessed?: number;
    detailsTotal?: number;
  }) => void;
};

/**
 * The statutes that cover the Faroese map, as `number/year`.
 *
 * A first pass, not a policy. 48 candidates are in force and this is the handful
 * that answers "draw the Faroese areas"; the output of these gets looked at by
 * eye before the net is widened, because the way this work goes wrong is
 * plausible-looking geometry nobody checked. Widen by passing `statutes`.
 *
 * `35/2026` is deliberately absent: it is a permit and fishing-day regime rather
 * than a closure, and the gate should reach that conclusion on its own. It is a
 * useful thing to run explicitly and watch produce nothing.
 */
export const FIRST_PASS_STATUTES = [
  "30/2018",
  "113/2014",
  "197/2021",
  "193/2017",
  "39/2019",
  "27/2024",
  "229/2025",
  "45/2022",
];

/** `Kunngerð nr. 35 (2026)` → `35/2026`; anything else → null. */
export function statuteNumberOf(title: string): string | null {
  const match = /nr\.\s*(\d+).*?\((\d{4})\)/.exec(title);
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * The row key in `jmelding_geo`, matching the `LOG-K-35-2026` rows the earlier
 * ingest wrote so a statute re-ingested under this pipeline REPLACES its old row
 * rather than sitting beside it.
 */
export function closureJmNumber(statuteNumber: string): string {
  return `LOG-K-${statuteNumber.replace("/", "-")}`;
}

export const FAROESE_WATERS_CATEGORY = "lógasavn friðing (statutory closure)";
export const INTERNATIONAL_WATERS_CATEGORY =
  "lógasavn økisfriðing í altjóða sjógvi (NEAFC/NAFO)";

/**
 * Statutes that close INTERNATIONAL water, not Faroese water.
 *
 * The Faroes legislate for NEAFC and NAFO areas too, and those closures are
 * real — but they sit in the mid-Atlantic and off Newfoundland, thousands of
 * kilometres from the Faroe Islands. On the first live draw, 50 of the 76 rings
 * returned for "show me the Faroese closures" were these: correct geometry,
 * correct law, wrong answer to the question asked.
 *
 * Detected from the statute's own title rather than from a bounding box. The
 * law says which regime it implements — `altjóða sjógvi` is "international
 * waters" — and a box drawn round the Faroes cannot separate them cleanly
 * anyway: `K 113/2014` reaches 59.8°N / 13.2°W, which any box wide enough to
 * hold the Faroese closures also contains.
 *
 * Region stays `FO` (the Faroes are the publishing jurisdiction, and the region
 * enum has no third option); the CATEGORY is what lets a caller tell them apart.
 */
const INTERNATIONAL_WATERS_RE = /NEAFC|NAFO|altjóða sjógvi/i;

export function categoryFor(title: string): string {
  return INTERNATIONAL_WATERS_RE.test(title)
    ? INTERNATIONAL_WATERS_CATEGORY
    : FAROESE_WATERS_CATEGORY;
}

/**
 * Bump to force one re-emit of every statute, once.
 *
 * The pathway suppresses a re-emit whose signature is unchanged, which is
 * exactly what you want until the day you need already-ingested rows to pick up
 * a new column. Then you need a deliberate, one-shot trigger — and the honest
 * one is a version you bump on purpose, not a field you smuggle into the hash
 * hoping it differs.
 *
 * 2 — `summary` and `category` were added to `jmelding_geo`; the rows ingested
 *     under version 1 carry neither.
 */
const SIGNATURE_VERSION = 2;

/**
 * What "the same drawing" means, for suppression purposes.
 *
 * Deliberately covers the INPUTS and the GEOMETRY, and nothing the model wrote
 * in prose. `summary` and the ring labels are LLM output, the reader has no
 * sampling controls through the embed API, and the embed config can move to a
 * different model between runs without this code changing at all. This
 * pipeline has already been measured wobbling — the same statute enumerated 8
 * rings on one run and 5 on the next. Put that in the suppression key and every
 * statute re-emits on every run forever, for no change a reader could see: the
 * upsert keeps the row correct, so it is not corruption, just permanent event
 * growth on a pathway whose pump is already running behind.
 *
 * What DOES belong: `contentHash` (the statute text moved), `category` (derived
 * deterministically from the title), and the vertices. A re-classification from
 * closure to exemption is caught by the geometry, because an exemption is not
 * emitted at all and the ring leaves `areas` entirely.
 *
 * Corollary: a label that changes while the statute text does not is model
 * drift, not new information, and should not re-emit. When something real does
 * change, the fresh labels ride along on the same event.
 */
export function signatureFor(input: {
  statuteNumber: string;
  contentHash: string;
  category: string;
  areas: Array<{ points: Array<{ lat: number; lon: number }> }>;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: SIGNATURE_VERSION,
        statuteNumber: input.statuteNumber,
        contentHash: input.contentHash,
        category: input.category,
        areas: input.areas.map((area) => ({ points: area.points })),
      }),
    )
    .digest("hex");
}

function selectCandidates(
  candidates: IndexCandidate[],
  wanted: string[],
): IndexCandidate[] {
  const want = new Set(wanted);
  return candidates.filter((candidate) => {
    // Superseded statutes are indexed on purpose and must never be drawn.
    if (!candidate.inForce) return false;
    const number = statuteNumberOf(candidate.title);
    return number != null && want.has(number);
  });
}

/**
 * One line per statute, so a run that drew nothing says why.
 *
 * `agreed` is what the two readers agreed on, which is NOT the same as what was
 * emitted — a statute the reader declares out of force is skipped whole, with
 * its rings still agreed. Reporting the agreement as though it were the output
 * would put "1 drawn" in the log beside an empty pathway.
 */
function describe(
  candidate: IndexCandidate,
  result: ComparisonResult,
  skipped: string | null,
): string {
  const withheld = result.withheld
    .map((ring) => `${ringLabel(ring.reading)}: ${ring.reason}`)
    .join("; ");
  const detail = withheld ? ` [${withheld}]` : "";
  const outcome = skipped ? ` — NOTHING EMITTED: ${skipped}` : "";
  return `${candidate.title} — ${result.agreed.length} agreed, ${result.withheld.length} withheld, ${result.unclaimed.length} unclaimed${detail}${outcome}`;
}

/**
 * 🇫🇴 Lógasavn statutory closures — the geometry behind "draw the Faroese areas".
 *
 * Two readers, and the disagreement between them is the gate. An LLM reads each
 * statute and says what its rings MEAN — which `§`, closure or exemption,
 * seasonal or not — because that is a question about Faroese prose. `extractAreas`
 * reads the same text independently and says where the vertices are. A ring both
 * agree on is emitted; a ring they differ about is withheld and counted, never
 * reconciled.
 *
 * The model never handles a coordinate as a NUMBER: it quotes each vertex as the
 * statute prints it and the same tokenizer converts both sides, so what the gate
 * compares is transcription. That is also why none of the drawing-tool guards
 * are involved here — on this path there is no model-supplied coordinate for one
 * to guard.
 *
 * Emits onto the shared J-melding announcement pathway with `region: "FO"`, so
 * `draw_regulations` returns these beside the Vørn bans with no FE change at all.
 * `sourceFragmentId` is NOT optional: the geo projector skips Vørn's ring-repair
 * for rows that carry it, and that repair — right for hand-transcribed ban pages
 * — can silently move a statute vertex, which is the one failure class nothing
 * downstream can detect.
 */
export function createLogasavnClosuresJob(
  env: Env,
  writer: PathwayWriter,
  usable: LogasavnClosuresUsable,
  read: StatuteReader,
) {
  return async function runLogasavnClosuresJob(
    _previous: JobState | undefined,
    args: { dryRun?: boolean; statutes?: string[] },
    context: Context,
  ): Promise<JobExecutionResult> {
    const checkedAt = new Date().toISOString();

    context.reportProgress({
      phase: "loading-index",
      message: `Reading ${INDEX_FRAGMENT_KEY}`,
    });
    const index = await usable.getFragmentByKey(
      env.USABLE_WORKSPACE_ID,
      INDEX_FRAGMENT_KEY,
    );
    if (!index?.content) {
      // The sweep publishes this daily. Its absence is a broken sweep, not an
      // empty corpus, and drawing nothing without saying so would look identical
      // to a clean run over a corpus with no closures in it.
      throw new Error(
        `No ${INDEX_FRAGMENT_KEY} fragment — run logasavn-sweep before this job`,
      );
    }

    const wanted = args.statutes ?? FIRST_PASS_STATUTES;
    const candidates = selectCandidates(
      parseIndexFragment(index.content),
      wanted,
    );
    if (candidates.length === 0) {
      throw new Error(
        `None of ${wanted.join(", ")} are in-force candidates in the index — refusing to report a clean run over nothing`,
      );
    }

    context.reportProgress({
      phase: "reading-statutes",
      message: `Reading ${candidates.length} statutes`,
      itemsDiscovered: candidates.length,
    });

    const lines: string[] = [];
    let drawn = 0;
    /** Rings the two readers could not agree on — the number that means trouble. */
    let withheld = 0;
    /**
     * Rings the reader correctly declined to call closures.
     *
     * Counted apart from `withheld` because lumping them together makes a run
     * that rightly refuses thirteen fishing-ground tables read exactly like a
     * run that broke. On the measured corpus the declinations dominate, so the
     * combined figure buried the two real disagreements behind a number that
     * looked alarming — this is the intent `WithholdReason` already documents,
     * finally applied to the aggregate and not only to the per-statute line.
     */
    let notClosures = 0;
    let unclaimed = 0;
    let failures = 0;

    for (const [position, candidate] of candidates.entries()) {
      if (context.signal.aborted || context.isStopRequested()) {
        throw new Error("Job stopped by request");
      }

      const fragment = await usable.getFragmentById(
        candidate.fragmentId,
        env.LOGASAVN_WORKSPACE_ID,
      );
      if (!fragment?.content) {
        lines.push(
          `${candidate.title} — fragment ${candidate.fragmentId} is unreadable`,
        );
        continue;
      }
      const body = bodyFromContent(fragment.content);

      // The two readings, taken independently of one another on purpose: the
      // parser is not shown the model's answer and vice versa, because a witness
      // that has seen the defendant's statement is not a second observation.
      //
      // Guarded per statute rather than around the loop. The obvious flaky
      // surface is the call itself — a 429, a `content` that is fenced or null
      // despite `strict: true`, a body that is not JSON — and an unguarded throw
      // would abandon the remaining statutes. On a live run the ones already
      // emitted would stay emitted, leaving the map half-updated and the job
      // reporting only that it failed. One bad statute should cost one statute.
      //
      // The parse and the compare are INSIDE the guard too, though neither
      // throws today. That is the point: "it cannot throw" is a claim about the
      // inputs seen so far, and this pipeline has already been surprised twice
      // by a corpus character nobody had met (`”`, `¢`). A malformed statute
      // taking out the other 47 would be the same failure as a 429 doing it,
      // and the containment is one line wider.
      let reading: StatuteReading;
      let result: ComparisonResult;
      try {
        reading = await read({
          title: candidate.title,
          body,
          url: candidate.url,
        });
        result = compareReading(reading, extractAreas(body));
      } catch (error) {
        failures += 1;
        const detail = error instanceof Error ? error.message : String(error);
        lines.push(`${candidate.title} — NOT READ: ${detail}`);
        continue;
      }

      for (const ring of result.withheld) {
        if (ring.reason === "not-a-closure") notClosures += 1;
        else withheld += 1;
      }
      unclaimed += result.unclaimed.length;

      const statuteNumber = statuteNumberOf(candidate.title);
      // The index says a statute is `Galdandi`; the reader has read its § on
      // entry into force and lapse. Where they differ the reading wins, because
      // the scan cannot read a lapse date and the reader can.
      const skipped = !reading.inForce
        ? "the reader says this statute is not in force"
        : !statuteNumber
          ? "its title carries no statute number to key the row on"
          : null;
      lines.push(describe(candidate, result, skipped));
      if (skipped || result.agreed.length === 0 || !statuteNumber) continue;

      const areas = result.agreed.map((ring) => ({
        name: ringLabel(ring.reading),
        // `lng` in the parser, `lon` on the wire. The rename is the only thing
        // happening here — no rounding, no re-projection.
        points: ring.points.map((point) => ({
          lat: point.lat,
          lon: point.lng,
        })),
      }));
      drawn += areas.length;

      if (args.dryRun) continue;

      await writer.writeJMeldingAnnouncement({
        signature: signatureFor({
          statuteNumber,
          contentHash: hashBody(body),
          category: categoryFor(candidate.title),
          areas,
        }),
        title: candidate.title,
        url: candidate.url ?? "",
        status: "current",
        jmNumber: closureJmNumber(statuteNumber),
        category: categoryFor(candidate.title),
        region: "FO",
        areas,
        // The reading goes in `summary`, which `jmelding_geo` keeps. NOT also
        // in `bodyMarkdown`: that field is the SOURCE text, and for a statute
        // the source is the Lógasavn fragment `sourceFragmentId` already points
        // at — copying a one-line reading into it would make the event claim to
        // carry a body it does not have.
        summary: reading.summary,
        // Empty on purpose. For a statute the source text is the Lógasavn
        // fragment `sourceFragmentId` points at, so there is no body of ours to
        // carry — and putting the one-line reading here instead would make the
        // event claim a body it does not have.
        bodyMarkdown: "",
        contentHash: hashBody(body),
        // Load-bearing — see the class doc and `geo-projector.ts:78`.
        sourceFragmentId: candidate.fragmentId,
        checkedAt,
      });

      context.reportProgress({
        phase: "emitting-closures",
        message: `Emitted ${position + 1}/${candidates.length} statutes`,
        detailsProcessed: position + 1,
        detailsTotal: candidates.length,
      });
    }

    // Unconditional, like the sweep's: these counts are the instrument, and an
    // instrument that reports only when unhappy cannot show you the day it
    // stopped working. `withheld` and `notClosures` stay apart — the first is
    // the two readers failing to agree, the second is the reader doing its job.
    const summary =
      `statutes: ${candidates.length}, rings drawn: ${drawn}, ` +
      `withheld (readers disagree): ${withheld}, ` +
      `declined (not closures): ${notClosures}, ` +
      `unclaimed by the reader: ${unclaimed}, statutes not read: ${failures}`;
    console.info("[LogasavnClosures]", summary);
    for (const line of lines) console.info("[LogasavnClosures]", line);

    return {
      checkedAt,
      changed: !args.dryRun && drawn > 0,
      latestItems: [],
      message: args.dryRun ? `Dry run — ${summary}` : summary,
    };
  };
}
