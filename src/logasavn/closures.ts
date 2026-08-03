/**
 * Turn APPROVED Lógasavn review rows into drawable closures.
 *
 * This is the last mile: `draw_regulations` reads `jmelding_geo` by region, so
 * a Faroese statute that lands there with `region: "FO"` and geometry appears
 * on the map with no frontend change at all.
 *
 * The gate is a human's approval, pinned to an exact statute text. Everything
 * here exists to make sure the thing drawn is the thing that was approved — see
 * `planClosureIngest`, which is the whole decision and is pure so it can be
 * tested without a network or a database.
 */

import type { ParsedArea } from "./areas";
import type { Recurrence, ReviewRow } from "./review";

/**
 * Prefix marking a `jmelding_geo` row as Lógasavn-derived.
 *
 * Needed because this job must RETRACT as well as insert, and to retract safely
 * it has to know which rows are its own. Region alone cannot say: Vørn's
 * emergency bans are `region: "FO"` too, and archiving one of those because a
 * statute lost its approval would take a live closure off the map.
 */
export const LOGASAVN_KEY_PREFIX = "LOG";

/** Human-readable and stable: `LOG-K-35-2026`. */
export function closureKey(input: {
  documentType?: string | null;
  lawNumber?: string | number | null;
  year?: string | number | null;
  fragmentId: string;
}): string {
  const type = (input.documentType ?? "").trim().charAt(0).toUpperCase();
  const number = String(input.lawNumber ?? "").trim();
  const year = String(input.year ?? "").trim();
  // Fall back to the fragment id rather than minting a key that could collide:
  // two statutes sharing a key would overwrite each other's geometry, silently.
  if (!type || !number || !year) {
    return `${LOGASAVN_KEY_PREFIX}-${input.fragmentId}`;
  }
  return `${LOGASAVN_KEY_PREFIX}-${type}-${number}-${year}`;
}

export type ClosureSource = {
  row: ReviewRow;
  /** Statute body as it reads RIGHT NOW, freshly fetched. */
  body: string | null;
  /** Hash of that body right now. Null when the fragment could not be read. */
  contentHash: string | null;
  documentType?: string | null;
  lawNumber?: string | number | null;
  year?: string | number | null;
  url?: string | null;
  areas: ParsedArea[];
};

export type ClosureEmission = {
  key: string;
  fragmentId: string;
  contentHash: string;
  title: string;
  url: string;
  /** The reviewer's seasonal window, carried through verbatim. */
  recurrence: Recurrence | null;
  areas: { name: string | null; points: { lat: number; lon: number }[] }[];
};

export type ClosureSkip = {
  key: string;
  fragmentId: string;
  title: string;
  reason: "hash_moved" | "unreadable" | "no_geometry";
};

/** A closure this service has already drawn, as the geo store knows it. */
export type DrawnClosure = {
  key: string;
  /** The Lógasavn fragment it came from — `jmelding_geo.fragment_id`. */
  fragmentId: string | null;
};

export type ClosurePlan = {
  emit: ClosureEmission[];
  skip: ClosureSkip[];
  /** Previously-drawn rows whose approval no longer holds. */
  retract: string[];
};

/**
 * Decide what to draw, what to withhold, and what to take back.
 *
 * Three rules, each closing a way a wrong shape could reach a skipper's screen:
 *
 * 1. **Re-verify the hash at draw time.** An approval is for one exact text. The
 *    sweep runs daily and this job runs after it, so a statute can be re-scraped
 *    between the approval and this moment. If the body no longer hashes to what
 *    was approved, it is NOT drawn — the sweep will have already re-opened it as
 *    `source_changed`, and drawing it here would use an approval given for text
 *    nobody has read. This is the same pin as everywhere else, applied at the
 *    last possible moment.
 * 2. **Withhold rather than guess.** A fragment we cannot read, or one that now
 *    yields no drawable ring, is skipped and counted — never emitted with
 *    partial geometry.
 * 3. **Retract what is no longer approved** — but never merely because we could
 *    not read it this run. A row previously drawn whose review
 *    row has been re-declined, or whose text moved, must stop being drawn.
 *    Un-approved means not on the map, and that has to hold going backwards as
 *    well as forwards or the fail-closed default only applies to statutes nobody
 *    ever approved.
 */
export function planClosureIngest(
  sources: ClosureSource[],
  alreadyDrawn: DrawnClosure[],
): ClosurePlan {
  const emit: ClosureEmission[] = [];
  const skip: ClosureSkip[] = [];

  for (const source of sources) {
    const key = closureKey({
      documentType: source.documentType,
      lawNumber: source.lawNumber,
      year: source.year,
      fragmentId: source.row.fragmentId,
    });
    const base = {
      key,
      fragmentId: source.row.fragmentId,
      title: source.row.title,
    };

    if (source.body == null || source.contentHash == null) {
      skip.push({ ...base, reason: "unreadable" });
      continue;
    }
    if (source.contentHash !== source.row.contentHash) {
      skip.push({ ...base, reason: "hash_moved" });
      continue;
    }
    const drawable = source.areas.filter((area) => area.points.length >= 3);
    if (drawable.length === 0) {
      skip.push({ ...base, reason: "no_geometry" });
      continue;
    }

    emit.push({
      key,
      fragmentId: source.row.fragmentId,
      contentHash: source.contentHash,
      title: source.row.title,
      url: source.url ?? "",
      // Verbatim from the verdict. The parser cannot produce this and must
      // never appear to: a season is a reviewer's interpretation.
      recurrence: source.row.recurrence,
      areas: drawable.map((area) => ({
        name: area.name,
        // `lng` inside the parser, `lon` on the wire — the announcement contract
        // and the geo store both say `lon`.
        points: area.points.map((point) => ({
          lat: point.lat,
          lon: point.lng,
        })),
      })),
    });
  }

  const emitting = new Set(emit.map((item) => item.key));
  // A statute we simply could not READ this run keeps whatever it already has
  // on the map. "We failed to fetch it" is not evidence the approval lapsed,
  // and treating it as such points the failure the dangerous way: a legally
  // in-force ban blinks off, and a skipper reading the map mid-blink sees open
  // water where there is a closure. One Usable blip would otherwise retract
  // EVERY drawn closure at once, because every fetch in the batch fails
  // together.
  //
  // Matched on fragment id, not key: an unreadable fragment has no frontmatter,
  // so its `closureKey` falls back to the id form and would never match the key
  // it was drawn under.
  const unreadable = new Set(
    skip
      .filter((item) => item.reason === "unreadable")
      .map((item) => item.fragmentId),
  );
  const retract = alreadyDrawn
    .filter((drawn) => drawn.key.startsWith(`${LOGASAVN_KEY_PREFIX}-`))
    .filter((drawn) => !emitting.has(drawn.key))
    // `hash_moved` and `no_geometry` DO retract: there the approval genuinely
    // no longer covers anything drawable. Only unreadability is withheld from
    // the judgement.
    .filter(
      (drawn) => drawn.fragmentId == null || !unreadable.has(drawn.fragmentId),
    )
    .map((drawn) => drawn.key);
  return { emit, skip, retract };
}
