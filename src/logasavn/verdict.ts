/**
 * What a reviewer is allowed to say about a Lógasavn candidate.
 *
 * Kept separate from the route so the rules can be tested without a server or
 * a database, and separate from `review.ts` because that module is the SWEEP's
 * half of the table — nothing there may ever write a verdict.
 */

import { z } from "zod";

/**
 * `MM-DD`, and a real calendar date.
 *
 * `13-01` and `02-31` both parse fine as strings and would silently produce a
 * season that never opens, on a closure whose whole purpose is to be open part
 * of the year. Day-per-month is checked against the longest possible month
 * (29 February is legitimate here — the window recurs every year, including
 * leap years).
 */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const monthDay = z
  .string()
  .regex(/^\d{2}-\d{2}$/, "expected MM-DD")
  .refine((value) => {
    const month = Number(value.slice(0, 2));
    const day = Number(value.slice(3, 5));
    if (month < 1 || month > 12 || day < 1) return false;
    return day <= (MONTH_DAYS[month - 1] as number);
  }, "not a real calendar date");

/**
 * A seasonal window, and the ONLY place recurrence can enter the system.
 *
 * No statute states its own recurrence — `árliga` appears zero times across the
 * drawable in-force statutes — so this is an interpretation a human makes, and
 * the parser is structurally incapable of supplying it.
 *
 * `from` later than `to` is allowed and means a window that wraps the year end.
 * None of the three known seasonal closures wrap, but rejecting it here would
 * push the next one into being recorded backwards.
 */
export const recurrenceSchema = z.object({
  type: z.literal("annual"),
  from: monthDay,
  to: monthDay,
});

/**
 * A decision, with the evidence that makes it reviewable later.
 *
 * `reviewedBy` is deliberately ABSENT: the route stamps it from the
 * authenticated admin, so an approval cannot be attributed to someone who did
 * not make it. Same reasoning as the POI write path.
 *
 * `pending` is not a decision and cannot be set here — a row starts pending and
 * the sweep is what returns it there, by observing new text. Letting a caller
 * hand-reset a row to pending would forge a source change that never happened.
 */
export const verdictInputSchema = z
  .object({
    status: z.enum(["approved", "declined"]),
    declineReason: z.string().trim().min(1).max(2000).optional(),
    recurrence: recurrenceSchema.nullish(),
  })
  .superRefine((input, ctx) => {
    // A decline without a reason is a silence, and the point of recording
    // declines at all is that the treaty documents are a DECISION rather than
    // an oversight. Six months on, "declined" with no reason is unreadable.
    if (input.status === "declined" && !input.declineReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["declineReason"],
        message: "declineReason is required when declining",
      });
    }
    if (input.status === "approved" && input.declineReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["declineReason"],
        message: "declineReason is only meaningful on a decline",
      });
    }
    // A declined area is never drawn, so a season on it is a contradiction —
    // and one that would sit in the table looking like a considered judgement.
    if (input.status === "declined" && input.recurrence) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recurrence"],
        message: "recurrence is only meaningful on an approval",
      });
    }
  });

export type VerdictInput = z.infer<typeof verdictInputSchema>;
