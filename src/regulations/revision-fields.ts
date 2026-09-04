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
