import { afterEach, describe, expect, test } from "bun:test";
import * as ExcelJS from "exceljs";
import { createSildelagetCatchJournalJob } from "../../src/jobs/sildelaget-catchjournal";
import type { PathwayWriter } from "../../src/pathways";
import type { SildelagetCatchRepository } from "../../src/sildelaget/repository";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("sildelaget-catchjournal job", () => {
  test("emits observed events without direct DB writes", async () => {
    const buffer = await makeWorkbook();
    globalThis.fetch = (async () =>
      new Response(new Uint8Array(buffer))) as unknown as typeof fetch;

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
      writeAreaCreated: async () => "unused",
      writeAreaUpdated: async () => "unused",
      writeAreaDeleted: async () => "unused",
    } satisfies PathwayWriter;

    const job = createSildelagetCatchJournalJob(
      {
        SILDELAGET_CATCHJOURNAL_EXPORT_URL:
          "https://example.test/ExportCatchJournal",
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
    expect(result.changed).toBe(true);
    expect(result.message).toContain("emitted 1 changed entries");
  });
});

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
