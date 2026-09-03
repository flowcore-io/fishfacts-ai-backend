import { afterEach, describe, expect, test } from "bun:test";
import * as ExcelJS from "exceljs";
import { createSildelagetCatchJournalJob } from "../../src/jobs/sildelaget-catchjournal";
import type { PathwayWriter } from "../../src/pathways";
import { parseSildelagetCatchWorkbook } from "../../src/sildelaget/catch-parser";
import type { SildelagetCatchRepository } from "../../src/sildelaget/repository";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("sildelaget-catchjournal job", () => {
  test("emits observed events without direct DB writes", async () => {
    const buffer = await makeWorkbook();
    globalThis.fetch = makeFetch(buffer);

    let hashReads = 0;
    const repository = {
      getEntryHashes: async () => {
        hashReads += 1;
        return new Map<string, string>();
      },
    } as unknown as SildelagetCatchRepository;
    const emitted: unknown[] = [];
    const writer = {
      writeGeneric: async () => "unused",
      writeJMeldingAnnouncement: async () => "unused",
      writeSildelagetCatchEntryObserved: async (entry) => {
        emitted.push(entry);
        return "evt-sild";
      },
      writeGillnetVesselObserved: async () => "unused",
      writeGebcoFeatureObserved: async () => "unused",
      writeAreaCreated: async () => "unused",
      writeAreaUpdated: async () => "unused",
      writeAreaDeleted: async () => "unused",
      writePoiCreated: async () => "unused",
      writeRegulationVerdictRecorded: async () => "unused",
      writeAisPositionFixObserved: async () => "unused",
      writeAisPositionFixBatch: async () => [],
    } satisfies PathwayWriter;

    const job = createSildelagetCatchJournalJob(
      {
        SILDELAGET_CATCHJOURNAL_EXPORT_URL:
          "https://example.test/ExportCatchJournal",
        SILDELAGET_CATCHMAP_AREAS_URL: "https://example.test/CatchAreas",
      } as never,
      writer,
      repository,
    );

    const result = await job(
      undefined,
      {
        selectedTime: 168,
        selectedSpecies: "",
        selectedCatchType: "",
        isNor: true,
      },
      {
        signal: new AbortController().signal,
        isStopRequested: () => false,
        reportProgress: () => undefined,
      },
    );

    expect(hashReads).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      lines: [
        expect.objectContaining({
          route: "5",
          routeKey: "#0005",
          routeFaoArea: "27.4.A",
          routeCenterLatitude: 60.5,
          routeCenterLongitude: 2.5,
        }),
      ],
    });
    expect(result.changed).toBe(true);
    expect(result.message).toContain("emitted 1 changed entries");
  });

  test("uses uncapped selectedTime as export duration", async () => {
    const buffer = await makeWorkbook();
    let requestedUrl: string | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("CatchAreas")) {
        return Response.json(routeAreasFixture());
      }
      requestedUrl = url;
      return new Response(new Uint8Array(buffer));
    }) as unknown as typeof fetch;

    const repository = {
      getEntryHashes: async () => new Map<string, string>(),
    } as unknown as SildelagetCatchRepository;
    const emitted: unknown[] = [];
    const writer = {
      writeGeneric: async () => "unused",
      writeJMeldingAnnouncement: async () => "unused",
      writeSildelagetCatchEntryObserved: async (entry) => {
        emitted.push(entry);
        return "evt-sild";
      },
      writeGillnetVesselObserved: async () => "unused",
      writeGebcoFeatureObserved: async () => "unused",
      writeAreaCreated: async () => "unused",
      writeAreaUpdated: async () => "unused",
      writeAreaDeleted: async () => "unused",
      writePoiCreated: async () => "unused",
      writeRegulationVerdictRecorded: async () => "unused",
      writeAisPositionFixObserved: async () => "unused",
      writeAisPositionFixBatch: async () => [],
    } satisfies PathwayWriter;

    const job = createSildelagetCatchJournalJob(
      {
        SILDELAGET_CATCHJOURNAL_EXPORT_URL:
          "https://example.test/ExportCatchJournal",
        SILDELAGET_CATCHMAP_AREAS_URL: "https://example.test/CatchAreas",
      } as never,
      writer,
      repository,
    );

    const result = await job(
      undefined,
      {
        selectedTime: 87600,
        selectedSpecies: "",
        selectedCatchType: "",
        isNor: true,
      },
      {
        signal: new AbortController().signal,
        isStopRequested: () => false,
        reportProgress: () => undefined,
      },
    );

    expect(result.changed).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(requestedUrl).toBeDefined();
    expect(
      new URL(requestedUrl as string).searchParams.get("selectedTime"),
    ).toBe("87600");
  });

  test("manual backfill emits unchanged entries for route import", async () => {
    const buffer = await makeWorkbook();
    const parsed = await parseSildelagetCatchWorkbook(buffer, {
      sourceUrl: "https://example.test/ExportCatchJournal?selectedTime=8760",
      checkedAt: "2026-06-04T10:00:00.000Z",
    });
    globalThis.fetch = makeFetch(buffer);

    const repository = {
      getEntryHashes: async () =>
        new Map<string, string>([
          [parsed[0].innmeldingId, parsed[0].entryHash],
        ]),
    } as unknown as SildelagetCatchRepository;
    const emitted: unknown[] = [];
    const writer = {
      writeGeneric: async () => "unused",
      writeJMeldingAnnouncement: async () => "unused",
      writeSildelagetCatchEntryObserved: async (entry) => {
        emitted.push(entry);
        return "evt-sild";
      },
      writeGillnetVesselObserved: async () => "unused",
      writeGebcoFeatureObserved: async () => "unused",
      writeAreaCreated: async () => "unused",
      writeAreaUpdated: async () => "unused",
      writeAreaDeleted: async () => "unused",
      writePoiCreated: async () => "unused",
      writeRegulationVerdictRecorded: async () => "unused",
      writeAisPositionFixObserved: async () => "unused",
      writeAisPositionFixBatch: async () => [],
    } satisfies PathwayWriter;

    const job = createSildelagetCatchJournalJob(
      {
        SILDELAGET_CATCHJOURNAL_EXPORT_URL:
          "https://example.test/ExportCatchJournal",
        SILDELAGET_CATCHMAP_AREAS_URL: "https://example.test/CatchAreas",
      } as never,
      writer,
      repository,
    );

    const result = await job(
      undefined,
      {
        selectedTime: 8760,
        selectedSpecies: "",
        selectedCatchType: "",
        isNor: true,
        backfill: true,
      },
      {
        signal: new AbortController().signal,
        isStopRequested: () => false,
        reportProgress: () => undefined,
      },
    );

    expect(result.changed).toBe(true);
    expect(result.message).toContain("emitted 1 backfill entries");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      entryHash: parsed[0].entryHash,
      lines: [expect.objectContaining({ routeKey: "#0005" })],
    });
  });
});

function makeFetch(buffer: Buffer): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes("CatchAreas")) return Response.json(routeAreasFixture());
    return new Response(new Uint8Array(buffer));
  }) as unknown as typeof fetch;
}

function routeAreasFixture() {
  return {
    "#0005": {
      Rute: "#0005",
      Center: { Latitude: 60.5, Longitude: 2.5 },
      FAOArea: "27.4.A",
      Coordinates: [
        { Latitude: 60, Longitude: 2 },
        { Latitude: 61, Longitude: 2 },
        { Latitude: 61, Longitude: 3 },
        { Latitude: 60, Longitude: 3 },
        { Latitude: 60, Longitude: 2 },
      ],
    },
  };
}

async function makeWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Innmeldingsjournal");
  worksheet.addRow([
    "Innmeldingsid",
    "Dato",
    "Kl",
    "Dato",
    "Kl",
    "Art",
    "Reg.mrk",
    "Båtnavn",
    "Leiefartøy",
    "Øk. sone",
    "Kommune",
    "Tonn",
    "Snitt",
    "Fangsttype",
    "OF",
    "Fangstredskap",
    "Rute",
    "Anvendelse",
    "%1",
    "%2",
    "%3",
    "%4",
    "Sortiment informasjon",
    "Utbud Øst (S)",
    "Dato",
    "Kl",
    "Utbud Øst (N)",
    "Dato",
    "Kl",
    "Utbud Vest (S)",
    "Dato",
    "Kl",
    "Utbud Vest (N)",
    "Dato",
    "Kl",
    "Samfisker",
    "Kjøper",
    "Mottak",
    "Nasjonalitet",
  ]);
  worksheet.addRow([
    "job-test-1",
    "01.06.2026",
    "09:00",
    "31.05.2026",
    "22:00",
    "NVG-sild",
    "FO-123",
    "Fiskebas",
    "",
    "NO",
    "Torshavn",
    2,
    325,
    "Direkte",
    "Auksjon",
    "Not",
    "5",
    "Konsum",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "Buyer AS",
    "Receiver AS",
    "NO",
  ]);
  return Buffer.from((await workbook.xlsx.writeBuffer()) as ArrayBuffer);
}
