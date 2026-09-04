import { timestampToIso } from "@/db/client";
import type * as schema from "@/db/schema";
import type { RegulationRevisionFields } from "@/events/contracts";
import type { RegulationApplicability } from "./applicability";

type CaseRow = typeof schema.regulationCases.$inferSelect;

/**
 * The editable-field snapshot of a case row, in the event-contract shape
 * (ISO instants, explicit nulls). Every revision — collector or redraft —
 * stores one of these, so moving the current-revision pointer restores the
 * full field state without replaying a delta chain.
 */
export function editableFieldsOfCase(
  row: Pick<
    CaseRow,
    | "title"
    | "authority"
    | "regulationNumber"
    | "category"
    | "summary"
    | "effectiveFrom"
    | "effectiveTo"
    | "expiresAt"
    | "seasonalRecurrence"
    | "interpretationNotes"
    | "applicability"
  >,
): RegulationRevisionFields {
  return {
    title: row.title,
    authority: row.authority,
    regulationNumber: row.regulationNumber,
    category: row.category,
    summary: row.summary,
    effectiveFrom: timestampToIso(row.effectiveFrom) ?? null,
    effectiveTo: timestampToIso(row.effectiveTo) ?? null,
    expiresAt: timestampToIso(row.expiresAt) ?? null,
    seasonalRecurrence: row.seasonalRecurrence,
    interpretationNotes: row.interpretationNotes,
    applicability:
      (row.applicability as RegulationApplicability | null) ?? null,
  };
}

/**
 * Structural equality for editable-field values, key-order independent —
 * `JSON.stringify` comparison would count a re-serialized `applicability`
 * with reordered keys as a change (forcing a phantom justification) and is
 * the wrong tool the day a real change reorders keys too.
 */
export function fieldValueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((entry, index) => fieldValueEquals(entry, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) =>
      fieldValueEquals(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
    );
  }
  return false;
}

/** The same snapshot as case-row column values, for writing it back. */
export function caseColumnsOfFields(
  fields: RegulationRevisionFields,
): Partial<typeof schema.regulationCases.$inferInsert> {
  return {
    title: fields.title,
    authority: fields.authority,
    regulationNumber: fields.regulationNumber,
    category: fields.category,
    summary: fields.summary,
    effectiveFrom: fields.effectiveFrom ? new Date(fields.effectiveFrom) : null,
    effectiveTo: fields.effectiveTo ? new Date(fields.effectiveTo) : null,
    expiresAt: fields.expiresAt ? new Date(fields.expiresAt) : null,
    seasonalRecurrence: fields.seasonalRecurrence,
    interpretationNotes: fields.interpretationNotes,
    applicability: fields.applicability,
  };
}
