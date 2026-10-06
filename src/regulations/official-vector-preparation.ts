import { timestampToIso } from "@/db/client";
import type { RegulationRevisionGeometry } from "@/events/contracts";
import { canonicalDigest } from "@/events/json-digest";
import type { EvidenceRun, OfficialVector } from "@/events/official-vector";
import { jmeldingSections, parseJmeldingEvidence } from "@/jmelding/geo-parser";
import { deterministicUuid } from "./ids";
import type { OfficialAreaRepository } from "./official-area-repository";
import {
  evidenceId,
  officialSnapshotId,
  verifyOfficialVector,
} from "./official-vector";
import type { RegulationQueueReadRepository } from "./read-repository";
import { editableFieldsOfCase, snapshotOnlyFieldsOf } from "./revision-fields";
import type { RegulationRevisionSnapshotRuntime } from "./revision-snapshot-runtime";

export class OfficialPreparationError extends Error {
  constructor(
    readonly code: string,
    readonly status: 409 | 422,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}
/** Source text and authority geometry are independent evidence. Only actual
 * statute headings pair runs with sections; a display label never supplies it. */
export class OfficialVectorPreparation {
  constructor(
    private readonly queue: RegulationQueueReadRepository,
    private readonly official: OfficialAreaRepository,
    private readonly snapshots: RegulationRevisionSnapshotRuntime,
  ) {}
  async prepare(
    caseId: string,
    actor: string,
    options: { baseRevisionId?: string; requestId?: string } = {},
  ) {
    const row = await this.queue.getCaseRow(caseId);
    if (!row) return null;
    if (
      row.jurisdiction !== "NO" ||
      row.sourceType !== "fiskeridir-jmelding" ||
      row.geometryModelVersion !== 0
    )
      throw new OfficialPreparationError("official_source_required", 422);
    // Retrying an uncertain write resumes precisely the previously reserved bytes.
    if (options.requestId) {
      const status = await this.snapshots.status(caseId, options.requestId);
      if (status) {
        const result = await this.snapshots.retry(
          caseId,
          options.requestId,
          actor,
          options.baseRevisionId,
        );
        return {
          outcome: "proposed" as const,
          revisionId: options.requestId,
          ...result,
          status: status.status,
        };
      }
    }
    const baseId = options.baseRevisionId ?? row.currentRevisionId;
    if (row.currentRevisionId !== baseId)
      throw new OfficialPreparationError("stale_revision", 409, {
        currentRevisionId: row.currentRevisionId,
        namedRevisionId: baseId,
      });
    const revision = await this.queue.getRevision(baseId);
    if (!revision || revision.caseId !== caseId || !revision.snapshotText)
      throw new OfficialPreparationError("no_snapshot_text", 422);
    const sourceContentHash = canonicalDigest(revision.snapshotText);
    const cache = await this.official.listForCase(caseId);
    const byParagraph = new Map(cache.map((area) => [area.paragraph, area]));
    const runs = parseJmeldingEvidence(revision.snapshotText);
    const groups = new Map<
      string,
      { paragraph: number | null; runs: EvidenceRun[] }
    >();
    for (const [position, run] of runs.entries()) {
      const key =
        run.paragraph === null
          ? `unmatched:${position}`
          : String(run.paragraph);
      let group = groups.get(key);
      if (!group) {
        group = { paragraph: run.paragraph, runs: [] };
        groups.set(key, group);
      }
      group.runs.push({
        id: evidenceId(sourceContentHash, position),
        position,
        name: run.name,
        section: run.paragraph === null ? null : `§ ${run.paragraph}`,
        points: run.points,
        verticesQuoted: null,
      });
    }
    // Official closures without parsed points remain visible; their actual
    // section must still exist in the law before they can receive a binding.
    const sections = jmeldingSections(revision.snapshotText);
    for (const area of cache)
      if (!groups.has(String(area.paragraph)))
        groups.set(String(area.paragraph), {
          paragraph: area.paragraph,
          runs: [],
        });
    const geometries: RegulationRevisionGeometry[] = [];
    for (const group of groups.values()) {
      const area =
        group.paragraph === null ? undefined : byParagraph.get(group.paragraph);
      const metadata = area?.sourceMetadata as {
        sourceRef?: string;
        featureIds?: string[];
      } | null;
      let officialVector: OfficialVector | null = null;
      if (
        area &&
        revision.sourceTextComplete !== false &&
        group.paragraph !== null &&
        sections.has(group.paragraph) &&
        metadata?.sourceRef?.toLowerCase() === row.sourceRef.toLowerCase()
      ) {
        const geometryHash = canonicalDigest(area.geojson);
        const content = {
          geometryHash,
          geojson: area.geojson as OfficialVector["geojson"],
          provenance: {
            source: "fiskeridir-wfs" as const,
            sourceUrl:
              "https://gis.fiskeridir.no/server/rest/services/J_melding_stengt_wfs/MapServer/0/query" as const,
            sourceRef: row.sourceRef,
            paragraph: group.paragraph,
            sourceContentHash,
            sourceVersion: geometryHash,
            fetchedAt: timestampToIso(area.fetchedAt),
            featureIds: metadata.featureIds ?? [],
            attribution: "Fiskeridirektoratet · NLOD" as const,
          },
        };
        officialVector = verifyOfficialVector({
          ...content,
          snapshotId: officialSnapshotId(content),
        });
      }
      geometries.push({
        name: area?.name ?? group.runs[0]?.name ?? null,
        section: group.paragraph === null ? null : `§ ${group.paragraph}`,
        paragraph: group.paragraph,
        kind: "closure",
        season: null,
        verticesQuoted: null,
        points: [],
        geometrySource: "official-vector",
        coordinateSystem: "WGS84",
        precision: null,
        officialVector,
        evidenceRuns: group.runs,
      });
    }
    if (!geometries.length)
      throw new OfficialPreparationError("official_geometry_unavailable", 422);
    const current = await this.queue.getRevisionGeometries(baseId);
    const fingerprint = (
      areas: Array<{
        name?: string | null;
        section?: string | null;
        kind?: string | null;
        season?: string | null;
        geometrySource: string;
        paragraph?: number | null;
        evidenceRuns?: unknown;
        officialVector?: OfficialVector | null;
      }>,
    ) =>
      canonicalDigest(
        areas.map((g) => ({
          name: g.name ?? null,
          section: g.section ?? null,
          kind: g.kind ?? null,
          season: g.season ?? null,
          geometrySource: g.geometrySource,
          paragraph: g.paragraph ?? null,
          evidenceRuns: g.evidenceRuns ?? null,
          geometryHash: g.officialVector?.geometryHash ?? null,
          sourceContentHash:
            g.officialVector?.provenance.sourceContentHash ?? null,
          featureIds: g.officialVector?.provenance.featureIds ?? null,
        })),
      );
    if (fingerprint(current) === fingerprint(geometries))
      return { outcome: "no_change" as const, areasParsed: geometries.length };
    const revisionId =
      options.requestId ??
      deterministicUuid(
        "official-vector-operation",
        canonicalDigest({
          caseId,
          baseId,
          actor,
          geometries: fingerprint(geometries),
        }),
      );
    if (await this.snapshots.status(caseId, revisionId)) {
      const result = await this.snapshots.retry(
        caseId,
        revisionId,
        actor,
        baseId,
      );
      return {
        outcome: "proposed" as const,
        revisionId,
        areasParsed: geometries.length,
        ...result,
      };
    }
    const recordedAt = new Date().toISOString();
    const result = await this.snapshots.submit({
      revisionId,
      caseId,
      caseKey: row.caseKey,
      baseRevisionId: baseId,
      changes: [
        {
          field: "geometries",
          justification:
            "Bind the authority's exact published polygons to the stored J-melding and sections; retain printed coordinates as separate evidence.",
        },
      ],
      fields: editableFieldsOfCase(row, snapshotOnlyFieldsOf(revision.fields)),
      geometries,
      actor,
      recordedAt,
    });
    return {
      outcome: "proposed" as const,
      revisionId,
      recordedAt,
      areasParsed: geometries.length,
      areasBefore: current.length,
      ...result,
    };
  }
}
