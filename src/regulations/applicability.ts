import { z } from "zod";

/**
 * The Applicability block of a regulation case (§4 of Gilli's plan), as
 * queryable structure.
 *
 * "Applicability differs" is a first-class source-comparison state (§9), so
 * species, gear, vessel class and activity must be COMPARABLE between two
 * records — which rules out free text. Every field is optional: a statute
 * that names no gear restricts all gear, and absence must stay
 * distinguishable from an empty list someone asserted.
 *
 * Three states, all distinct and all meaningful:
 * - `applicability: null` — nobody has extracted it yet;
 * - the object present, a dimension key absent — the source states no
 *   restriction on that dimension;
 * - a dimension key present — the source states that restriction.
 */
const applicabilityDimensionsSchema = z.object({
  species: z.array(z.string().min(1)).optional(),
  gear: z.array(z.string().min(1)).optional(),
  vesselType: z.array(z.string().min(1)).optional(),
  /** Metres / horsepower bounds as printed, e.g. `{ max: "120 BT" }`. */
  vesselLength: z
    .object({ min: z.string().optional(), max: z.string().optional() })
    .optional(),
  vesselPower: z
    .object({ min: z.string().optional(), max: z.string().optional() })
    .optional(),
  vesselFlag: z.array(z.string().min(1)).optional(),
  fishery: z.array(z.string().min(1)).optional(),
  permits: z.array(z.string().min(1)).optional(),
  exemptions: z.array(z.string().min(1)).optional(),
  /** Whether the listed activity is prohibited or allowed inside the areas —
   * K 27/2024's flatfish areas are seasonal PERMISSIONS, not closures, and
   * only this field can say so. */
  activity: z.enum(["prohibited", "allowed"]).optional(),
});

/**
 * The dimension names, in schema order — everything an extraction may state
 * and therefore everything that needs a quote behind it. Derived from the
 * dimension schema rather than re-typed, so a twelfth dimension cannot be
 * added without the evidence map and the extraction prompt following it (the
 * unit tests beside this file lock that).
 */
export const APPLICABILITY_DIMENSIONS =
  applicabilityDimensionsSchema.keyof().options;

export type ApplicabilityDimension = (typeof APPLICABILITY_DIMENSIONS)[number];

/**
 * The verbatim source quote behind each stated dimension (§4 Provenance).
 *
 * One quote per dimension the record states, copied character-for-character
 * out of the source text — the admin confirming an extraction has to be able
 * to find it there, and a value whose quote is not in the text is a value the
 * source never gave. The extraction refuses such an answer outright; see
 * `applicability-extraction.ts`.
 */
const applicabilityEvidenceSchema = z.object({
  species: z.string().min(1).optional(),
  gear: z.string().min(1).optional(),
  vesselType: z.string().min(1).optional(),
  vesselLength: z.string().min(1).optional(),
  vesselPower: z.string().min(1).optional(),
  vesselFlag: z.string().min(1).optional(),
  fishery: z.string().min(1).optional(),
  permits: z.string().min(1).optional(),
  exemptions: z.string().min(1).optional(),
  activity: z.string().min(1).optional(),
});

/**
 * Additive as of the applicability extraction: `evidence` and `notes` are
 * optional, so every revision stored before them still parses unchanged.
 */
export const regulationApplicabilitySchema =
  applicabilityDimensionsSchema.extend({
    evidence: applicabilityEvidenceSchema.optional(),
    /**
     * A message to the ADMIN reviewing the proposal, not part of the rule:
     * what the source left unsaid, which article to consult, why a dimension
     * was left out. A source that states no applicability at all yields
     * `{ notes }` and nothing else — which is a real answer, not a failure.
     */
    notes: z.string().min(1).max(4000).optional(),
  });

export type RegulationApplicability = z.infer<
  typeof regulationApplicabilitySchema
>;

export type RegulationApplicabilityEvidence = z.infer<
  typeof applicabilityEvidenceSchema
>;
