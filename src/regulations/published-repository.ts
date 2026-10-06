import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import type { RegulationRevisionFields } from "@/events/contracts";
import { canonicalDigest } from "@/events/json-digest";
import type { EvidenceRun, OfficialVector } from "@/events/official-vector";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { verifyApprovalEvidence } from "./approval-evidence";
import {
  type RevisionShapeState,
  sourceSignatureOf,
  verifyShapeState,
} from "./coastal-state";
import { RegulationGroupRepository } from "./group-repository";
import { caseIdFor } from "./ids";
import {
  hydrateOfficialGeometries,
  snapshotManifestHash,
  verifyOfficialVector,
} from "./official-vector";

/**
 * Read side of the PUBLISHED lane (stage ③) — what the user-facing 1st mate
 * lists and draws. Non-admin by design: every other regulations read is
 * ADMIN-gated because it exposes the review queue; this one serves only
 * cases a human approved, and only the revision the approval pinned.
 *
 * The pinned revision is the source of every field users see. The CASE
 * columns follow the current (draft) revision, so a redraft in progress
 * would leak unapproved edits if this read used them; the published
 * revision's `fields` snapshot is what was approved. Approving a
 * snapshot-less revision (pre-#172 collectors) now writes its snapshot at
 * pin time (revision-projector), so the case-column fallback below only
 * serves pins made before that fix — kept as defense, not as a path new
 * publishes may take: without a snapshot, a redraft's column writes would
 * leak straight into the published view.
 */

/**
 * The navigation group a regulation is listed under.
 *
 * Every published regulation has one: when the pinned revision names an
 * admin group that still exists and is active, that group; otherwise the
 * country's DEFAULT group, synthesised from the source type so day one
 * looks exactly like the source-based rows users had before groups existed.
 *
 * Groups are only ever reached THROUGH a member, which is what makes an
 * empty group and a retired group structurally invisible here rather than
 * filtered out by a rule someone could forget.
 */
export type PublishedRegulationGroup = {
  /** An admin group's uuid, or `default:<jurisdiction>:<sourceType>`. */
  id: string;
  name: string;
  /** Ascending. Admin groups come first; defaults sort after all of them. */
  sortOrder: number;
  isDefault: boolean;
};

/**
 * The default group names, byte-identical to the FE's `SOURCE_TYPE_LABELS`
 * (`src/other/regulations/publishedRegulations.ts`) — these ARE the rows the
 * map's Regulations dropdown shows today, so day one under groups has to
 * read the same. Copied rather than imported: different repositories.
 * An unmapped source type falls through to its own name, exactly as
 * `publishedSourceLabel` does.
 */
const DEFAULT_GROUP_LABELS: Record<string, string> = {
  "fiskeridir-jmelding": "J-melding closures",
  "fiskistofa-wfs": "Closures",
  logasavn: "Statutory closures",
  "vorn-veidibann": "Veiðibann",
};

/**
 * Default groups sort after every admin group. The floor is far above any
 * plausible admin count — a country's groups are named by hand, and a
 * reorder assigns positions from an array index — so an admin group can
 * never sort below a default.
 */
const DEFAULT_GROUP_SORT_FLOOR = 1000;

/** Their order among themselves, so the default rows keep a stable
 * sequence whatever mix of sources a read returns. Unmapped source types
 * sort last, among themselves by name. */
const DEFAULT_GROUP_ORDER = Object.keys(DEFAULT_GROUP_LABELS);

function defaultGroupOf(
  jurisdiction: string,
  sourceType: string,
): PublishedRegulationGroup {
  const known = DEFAULT_GROUP_ORDER.indexOf(sourceType);
  return {
    id: `default:${jurisdiction}:${sourceType}`,
    name: DEFAULT_GROUP_LABELS[sourceType] ?? sourceType,
    sortOrder:
      DEFAULT_GROUP_SORT_FLOOR +
      (known === -1 ? DEFAULT_GROUP_ORDER.length : known),
    isDefault: true,
  };
}

export type PublishedRegulationGeometry = {
  id: string;
  position: number;
  name: string | null;
  section: string | null;
  kind: string;
  season: string | null;
  /** The vertex SET as parsed, in source order — never a derived polygon. */
  points: Array<{ lat: number; lon: number }>;
  geometrySource: string;
  coordinateSystem: string;
  precision: string | null;
  paragraph?: number | null;
  geojson?: OfficialVector["geojson"] | null;
  snapshotId?: string | null;
  geometryHash?: string | null;
  provenance?: OfficialVector["provenance"] | null;
  evidenceRuns?: EvidenceRun[];
  resolutionStatus?: "resolved" | "unresolved";
};

export class GeometryClientUpgradeError extends Error {}
export type PublishedShape = Pick<
  RevisionShapeState["shapes"][number],
  | "id"
  | "position"
  | "name"
  | "section"
  | "kind"
  | "geojson"
  | "shapeHash"
  | "sourceRunPositions"
  | "provenance"
>;
export type PublishedRegulation = {
  geometryVersion?: 2;
  geometryModelVersion?: 0 | 1;
  sourceRef?: string;
  sourceSignature?: ReturnType<typeof sourceSignatureOf>;
  shapeManifestHash?: string | null;
  snapshotManifestHash?: string | null;
  shapes?: PublishedShape[];
  id: string;
  caseKey: string;
  jurisdiction: string;
  sourceType: string;
  sourceUrl: string;
  title: string;
  /** The short name an admin gave this regulation, when they gave one. An
   * ADDITION to `title`, never a replacement — the official title stays the
   * legal reference and the thing every citation names. Lives only in the
   * pinned revision's snapshot, so a pending rename is invisible here until
   * an approval moves the pin. */
  displayName: string | null;
  /** The navigation group this regulation is listed under — an admin group
   * from the PINNED revision, or the country's default. Never null. */
  group: PublishedRegulationGroup;
  authority: string | null;
  regulationNumber: string | null;
  category: string | null;
  summary: string | null;
  applicability: unknown;
  seasonalRecurrence: string | null;
  interpretationNotes: string | null;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  expiresAt: Date | null;
  /** When the SOURCE published the regulation (its own date, may be null). */
  sourcePublishedAt: Date | null;
  /** When an admin approved & published it to users, and the revision pinned. */
  publishedAt: Date | null;
  publishedRevisionId: string;
  /** Approved on legal validation alone — no geometry exists BY DESIGN;
   * an empty area list here is not a parse failure. */
  metadataOnly: boolean;
  /** Computed from the validity window at read time. */
  inForce: "current" | "upcoming" | "expired";
  geometries: PublishedRegulationGeometry[];
};

export type PublishedListFilters = {
  geometryVersion?: 1 | 2;
  jurisdiction?: string[];
  /** `current` = in force right now (the default consumers want);
   * `all` includes upcoming and expired. */
  status: "current" | "all";
  limit: number;
  offset: number;
};

export class RegulationPublishedReadRepository {
  private readonly groups: RegulationGroupRepository;

  constructor(private readonly db: Database) {
    this.groups = new RegulationGroupRepository(db);
  }

  /**
   * The published set is small by construction (each entry cost a human
   * approval), so the window filter runs here rather than in SQL: it has to
   * apply to the PINNED revision's dates, which live in the `fields`
   * snapshot, not on the case columns a draft may have moved.
   */
  async listPublished(
    filters: PublishedListFilters,
  ): Promise<{ regulations: PublishedRegulation[]; total: number }> {
    const conditions = [isNotNull(schema.regulationCases.publishedRevisionId)];
    if (filters.jurisdiction && filters.jurisdiction.length > 0) {
      conditions.push(
        inArray(schema.regulationCases.jurisdiction, filters.jurisdiction),
      );
    }
    const cases = await this.db
      .select()
      .from(schema.regulationCases)
      .where(and(...conditions))
      .orderBy(
        desc(schema.regulationCases.publishedToUsersAt),
        asc(schema.regulationCases.id),
      );
    const eligible =
      (filters.geometryVersion ?? 1) === 1
        ? await this.legacyPins(cases)
        : cases;
    const resolved = await this.resolve(eligible, filters.geometryVersion ?? 1);
    const matching =
      filters.status === "current"
        ? resolved.filter((item) => item.inForce === "current")
        : resolved;
    return {
      regulations: matching.slice(
        filters.offset,
        filters.offset + filters.limit,
      ),
      total: matching.length,
    };
  }

  /** The published-sync job's reconciliation read — no route serves this.
   * Cases that HAVE been published (an applied approval exists) but are not
   * published now: a decline cleared the pin, so their corpus fragments
   * must leave the collection. */
  async listWithdrawn(): Promise<Array<{ caseKey: string; title: string }>> {
    return await this.db
      .selectDistinct({
        caseKey: schema.regulationCases.caseKey,
        title: schema.regulationCases.title,
      })
      .from(schema.regulationCases)
      .innerJoin(
        schema.regulationCaseApprovals,
        and(
          eq(schema.regulationCaseApprovals.caseId, schema.regulationCases.id),
          eq(schema.regulationCaseApprovals.applied, true),
        ),
      )
      .where(isNull(schema.regulationCases.publishedRevisionId));
  }

  async getPublished(
    caseId: string,
    geometryVersion: 1 | 2 = 1,
  ): Promise<PublishedRegulation | null> {
    const [caseRow] = await this.db
      .select()
      .from(schema.regulationCases)
      .where(
        and(
          eq(schema.regulationCases.id, caseId),
          isNotNull(schema.regulationCases.publishedRevisionId),
        ),
      )
      .limit(1);
    if (!caseRow) return null;
    if (
      geometryVersion === 1 &&
      (await this.legacyPins([caseRow])).length === 0
    )
      throw new GeometryClientUpgradeError("geometry_client_upgrade_required");
    const [resolved] = await this.resolve([caseRow], geometryVersion);
    return resolved ?? null;
  }

  async getPublishedSource(
    sourceRef: string,
    geometryVersion: 1 | 2 = 2,
  ): Promise<PublishedRegulation | null> {
    const key = `fiskeridir-jmelding:${sourceRef}`;
    const result = await this.getPublished(caseIdFor(key), geometryVersion);
    return result?.caseKey === key &&
      result.sourceType === "fiskeridir-jmelding"
      ? result
      : null;
  }

  private async legacyPins(
    cases: Array<typeof schema.regulationCases.$inferSelect>,
  ) {
    if (!cases.length) return [];
    const revisions = await this.db
      .select({ id: schema.regulationCaseRevisions.id })
      .from(schema.regulationCaseRevisions)
      .where(
        and(
          inArray(
            schema.regulationCaseRevisions.id,
            cases.map((c) => c.publishedRevisionId as string),
          ),
          eq(schema.regulationCaseRevisions.geometryModelVersion, 0),
        ),
      );
    const official = await this.db
      .select({ revisionId: schema.regulationCaseGeometries.revisionId })
      .from(schema.regulationCaseGeometries)
      .where(
        and(
          inArray(
            schema.regulationCaseGeometries.revisionId,
            revisions.map((r) => r.id),
          ),
          eq(schema.regulationCaseGeometries.geometrySource, "official-vector"),
        ),
      );
    const exactIds = new Set(official.map((r) => r.revisionId));
    const ids = new Set(
      revisions.filter((r) => !exactIds.has(r.id)).map((r) => r.id),
    );
    return cases.filter((c) => ids.has(c.publishedRevisionId as string));
  }

  private async resolve(
    cases: Array<typeof schema.regulationCases.$inferSelect>,
    geometryVersion: 1 | 2,
  ): Promise<PublishedRegulation[]> {
    if (cases.length === 0) return [];
    const revisionIds = cases.map(
      (row) => row.publishedRevisionId as string, // isNotNull-filtered above
    );
    // Active groups of only the countries in this read: the published set
    // is always read per jurisdiction, and a retired group is deliberately
    // not fetched — its members fall back to their country default.
    const jurisdictions = [...new Set(cases.map((row) => row.jurisdiction))];
    const [revisions, geometries, activeGroups, approvals, validations] =
      await Promise.all([
        this.db
          .select({
            id: schema.regulationCaseRevisions.id,
            fields: schema.regulationCaseRevisions.fields,
            contentHash: schema.regulationCaseRevisions.contentHash,
            caseId: schema.regulationCaseRevisions.caseId,
            snapshotText: schema.regulationCaseRevisions.snapshotText,
            snapshotUrl: schema.regulationCaseRevisions.snapshotUrl,
            geometryModelVersion:
              schema.regulationCaseRevisions.geometryModelVersion,
            shapeState: schema.regulationCaseRevisions.shapeState,
          })
          .from(schema.regulationCaseRevisions)
          .where(inArray(schema.regulationCaseRevisions.id, revisionIds)),
        this.db
          .select({
            id: schema.regulationCaseGeometries.id,
            caseId: schema.regulationCaseGeometries.caseId,
            officialSnapshotId:
              schema.regulationCaseGeometries.officialSnapshotId,
            paragraph: schema.regulationCaseGeometries.paragraph,
            evidenceRuns: schema.regulationCaseGeometries.evidenceRuns,
            revisionId: schema.regulationCaseGeometries.revisionId,
            position: schema.regulationCaseGeometries.position,
            name: schema.regulationCaseGeometries.name,
            section: schema.regulationCaseGeometries.section,
            kind: schema.regulationCaseGeometries.kind,
            season: schema.regulationCaseGeometries.season,
            points: schema.regulationCaseGeometries.points,
            geometrySource: schema.regulationCaseGeometries.geometrySource,
            coordinateSystem: schema.regulationCaseGeometries.coordinateSystem,
            precision: schema.regulationCaseGeometries.precision,
          })
          .from(schema.regulationCaseGeometries)
          .where(
            inArray(schema.regulationCaseGeometries.revisionId, revisionIds),
          )
          .orderBy(asc(schema.regulationCaseGeometries.position)),
        this.groups.listActiveForJurisdictions(jurisdictions),
        this.db
          .select()
          .from(schema.regulationCaseApprovals)
          .where(
            and(
              inArray(schema.regulationCaseApprovals.revisionId, revisionIds),
              eq(schema.regulationCaseApprovals.applied, true),
            ),
          )
          .orderBy(
            desc(schema.regulationCaseApprovals.recordedAt),
            desc(schema.regulationCaseApprovals.commandSequence),
          ),
        this.db
          .select()
          .from(schema.regulationCaseValidations)
          .where(
            inArray(schema.regulationCaseValidations.revisionId, revisionIds),
          ),
      ]);
    const groupsById = new Map(
      activeGroups.map((group) => [group.groupId, group]),
    );
    const fieldsByRevision = new Map(
      revisions.map((revision) => [revision.id, revision.fields]),
    );
    const geometriesByRevision = new Map<
      string,
      PublishedRegulationGeometry[]
    >();
    for (const geometry of await hydrateOfficialGeometries(
      this.db,
      geometries,
    )) {
      const { revisionId, ...area } = geometry;
      const {
        officialVector: _payload,
        officialSnapshotId: _reference,
        ...dto
      } = area as typeof area & {
        officialVector?: unknown;
        officialSnapshotId?: string | null;
      };
      const list = geometriesByRevision.get(revisionId) ?? [];
      list.push({
        id: dto.id,
        position: dto.position,
        name: dto.name,
        section: dto.section,
        kind: dto.kind,
        season: dto.season,
        geometrySource: dto.geometrySource,
        coordinateSystem: dto.coordinateSystem,
        precision: dto.precision,
        points: area.points as Array<{ lat: number; lon: number }>,
        ...(dto.geometrySource === "official-vector"
          ? (dto as PublishedRegulationGeometry)
          : {}),
      });
      geometriesByRevision.set(revisionId, list);
    }
    /** The pinned snapshot's group when it is still an ACTIVE group of this
     * regulation's own country, else the country default. The jurisdiction
     * re-check matters: a case can be re-ingested under a different region,
     * and a group belongs to exactly one country. */
    const groupOf = (
      caseRow: typeof schema.regulationCases.$inferSelect,
      fields: RegulationRevisionFields | null | undefined,
    ): PublishedRegulationGroup => {
      const groupId = fields?.groupId ?? null;
      const group = groupId ? groupsById.get(groupId) : undefined;
      if (!group || group.jurisdiction !== caseRow.jurisdiction) {
        return defaultGroupOf(caseRow.jurisdiction, caseRow.sourceType);
      }
      return {
        id: group.groupId,
        name: group.name,
        sortOrder: group.sortOrder,
        isDefault: false,
      };
    };

    return cases.map((caseRow) => {
      const revisionId = caseRow.publishedRevisionId as string;
      const revision = revisions.find(
        (r) => r.id === revisionId && r.caseId === caseRow.id,
      );
      if (!revision) throw new Error("published revision missing or foreign");
      const raw = geometriesByRevision.get(revisionId) ?? [];
      const modeled = revision.geometryModelVersion === 1;
      const official = raw.filter(
        (g) => g.geometrySource === "official-vector",
      );
      if (official.length) {
        const approval = approvals.find(
          (a) =>
            a.id === caseRow.publishedApprovalId &&
            a.caseId === caseRow.id &&
            a.revisionId === revisionId &&
            a.metadataOnly === caseRow.publishedMetadataOnly,
        );
        if (!approval || approval.commandSequence === null)
          throw new Error("published official approval missing");
        const approvedSequence = approval.commandSequence;
        const evidence = approval.approvalEvidence as {
          kind?: string;
          snapshotManifestHash?: string;
          legalValidationId?: string;
          geometries?: Array<{
            geometryId: string;
            snapshotId: string;
            geometryHash: string;
            validationId: string;
          }>;
        } | null;
        const causal = (id: string | undefined, scope: string) =>
          validations.find(
            (v) =>
              v.id === id &&
              v.caseId === caseRow.id &&
              v.revisionId === revisionId &&
              v.scope === scope &&
              v.validated &&
              v.commandSequence !== null &&
              v.commandSequence < approvedSequence,
          );
        if (
          evidence?.kind !== "official-vector" ||
          evidence.snapshotManifestHash !== snapshotManifestHash(raw) ||
          !causal(evidence.legalValidationId, "legal")
        )
          throw new Error("published official legal evidence missing");
        for (const area of official) {
          if (
            !area.snapshotId ||
            !area.geojson ||
            !area.geometryHash ||
            !area.provenance
          ) {
            if (!caseRow.publishedMetadataOnly)
              throw new Error("published official geometry unresolved");
            continue;
          }
          if (
            area.provenance.sourceRef.toLowerCase() !==
              caseRow.sourceRef.toLowerCase() ||
            area.provenance.paragraph !== area.paragraph ||
            area.provenance.sourceContentHash !==
              canonicalDigest(revision.snapshotText)
          )
            throw new Error("published official binding mismatch");
          const receipt = evidence.geometries?.find(
            (g) =>
              g.geometryId === area.id &&
              g.snapshotId === area.snapshotId &&
              g.geometryHash === area.geometryHash,
          );
          const validated = receipt
            ? causal(receipt.validationId, "geometry")
            : undefined;
          if (
            !caseRow.publishedMetadataOnly &&
            (!validated ||
              validated.geometryId !== area.id ||
              validated.officialSnapshotId !== area.snapshotId ||
              validated.geometryHash !== area.geometryHash)
          )
            throw new Error(
              "published exact official validation evidence missing",
            );
        }
      }
      let shapeState: RevisionShapeState | null = null;
      if (modeled) {
        shapeState = verifyShapeState(
          revision.shapeState,
          revision.snapshotText,
          raw,
        );
        const approval = approvals.find(
          (a) =>
            a.id === caseRow.publishedApprovalId &&
            a.caseId === caseRow.id &&
            a.revisionId === revisionId &&
            a.metadataOnly === caseRow.publishedMetadataOnly,
        );
        if (!approval) throw new Error("published approval missing");
        const evidence = verifyApprovalEvidence(
          approval.approvalEvidence,
          shapeState,
          caseRow.publishedMetadataOnly,
        );
        const receipt = (
          id: string,
          scope: string,
          hash?: string,
          shapeId?: string,
        ) =>
          validations.some(
            (v) =>
              v.id === id &&
              v.caseId === caseRow.id &&
              v.revisionId === revisionId &&
              v.validated &&
              v.scope === scope &&
              (shapeId === undefined || v.shapeId === shapeId) &&
              (hash === undefined ||
                (scope === "shape" ? v.shapeHash : v.coverageHash) === hash) &&
              v.commandSequence !== null &&
              approval.commandSequence !== null &&
              v.commandSequence < approval.commandSequence,
          );
        if (
          !receipt(evidence.legalValidationId, "legal") ||
          (evidence.kind === "drawable" &&
            (!receipt(
              evidence.coverageValidationId,
              "coverage",
              evidence.coverageHash,
            ) ||
              evidence.shapes.some(
                (s) =>
                  !receipt(s.validationId, "shape", s.shapeHash, s.shapeId),
              )))
        )
          throw new Error("published validation receipt missing");
      }
      const fields = fieldsByRevision.get(revisionId) as
        | RegulationRevisionFields
        | null
        | undefined;
      // Same whole-snapshot gate as the scalar fields below: when a snapshot
      // exists, EVERY value comes from it — a missing date key reads as null,
      // never as "fall back to the case column", because the case column is
      // the in-progress draft and that fallback would be exactly the leak
      // the pinned-revision design exists to prevent.
      const effectiveFrom = fields
        ? dateOrNull(fields.effectiveFrom)
        : caseRow.effectiveFrom;
      const effectiveTo = fields
        ? dateOrNull(fields.effectiveTo)
        : caseRow.effectiveTo;
      const expiresAt = fields
        ? dateOrNull(fields.expiresAt)
        : caseRow.expiresAt;
      return {
        id: caseRow.id,
        caseKey: caseRow.caseKey,
        jurisdiction: caseRow.jurisdiction,
        sourceType: caseRow.sourceType,
        sourceUrl: revision.snapshotUrl,
        title: fields ? fields.title : caseRow.title,
        // No case-column fallback exists (or should): a snapshot-less pin
        // predates the field entirely.
        displayName: fields ? (fields.displayName ?? null) : null,
        group: groupOf(caseRow, fields),
        authority: fields ? fields.authority : caseRow.authority,
        regulationNumber: fields
          ? fields.regulationNumber
          : caseRow.regulationNumber,
        category: fields ? fields.category : caseRow.category,
        summary: fields ? fields.summary : caseRow.summary,
        applicability: fields ? fields.applicability : caseRow.applicability,
        seasonalRecurrence: fields
          ? fields.seasonalRecurrence
          : caseRow.seasonalRecurrence,
        interpretationNotes: fields
          ? fields.interpretationNotes
          : caseRow.interpretationNotes,
        effectiveFrom,
        effectiveTo,
        expiresAt,
        sourcePublishedAt: caseRow.publishedAt,
        publishedAt: caseRow.publishedToUsersAt,
        publishedRevisionId: revisionId,
        metadataOnly: caseRow.publishedMetadataOnly,
        inForce: inForceOf(effectiveFrom, effectiveTo, expiresAt),
        geometries: caseRow.publishedMetadataOnly ? [] : raw,
        ...(geometryVersion === 2
          ? {
              geometryVersion: 2 as const,
              ...(official.length
                ? { snapshotManifestHash: snapshotManifestHash(raw) }
                : {}),
              geometryModelVersion: modeled ? (1 as const) : (0 as const),
              sourceRef: caseRow.sourceRef,
              sourceSignature: modeled
                ? sourceSignatureOf(revision.snapshotText, raw)
                : null,
              shapeManifestHash: shapeState?.shapeManifestHash ?? null,
              shapes: caseRow.publishedMetadataOnly
                ? []
                : (shapeState?.shapes
                    .filter((s) => s.geojson !== null)
                    .map(
                      ({
                        id,
                        position,
                        name,
                        section,
                        kind,
                        geojson,
                        shapeHash,
                        sourceRunPositions,
                        provenance,
                      }) => ({
                        id,
                        position,
                        name,
                        section,
                        kind,
                        geojson,
                        shapeHash,
                        sourceRunPositions,
                        provenance,
                      }),
                    ) ?? []),
            }
          : {}),
      };
    });
  }
}

/** Revision `fields` store instants as ISO strings. */
function dateOrNull(iso: string | null | undefined): Date | null {
  return iso ? new Date(iso) : null;
}

/** Same reading of the validity window as the jmelding geo index: no window
 * means in force, `upcoming` is adopted-but-not-yet-open, and either end
 * date passing makes it `expired`. */
function inForceOf(
  effectiveFrom: Date | null,
  effectiveTo: Date | null,
  expiresAt: Date | null,
): "current" | "upcoming" | "expired" {
  const now = Date.now();
  const end = effectiveTo ?? expiresAt;
  if (end && end.getTime() < now) return "expired";
  if (effectiveFrom && effectiveFrom.getTime() > now) return "upcoming";
  return "current";
}
