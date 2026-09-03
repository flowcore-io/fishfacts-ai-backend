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
 * Nothing populates this in stage ① — the column exists so the model carries
 * §4's block from day one and stage ④'s population lands without a migration.
 */
export const regulationApplicabilitySchema = z.object({
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

export type RegulationApplicability = z.infer<
  typeof regulationApplicabilitySchema
>;
