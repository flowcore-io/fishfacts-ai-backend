import { describe, expect, test } from "bun:test";
import * as ExcelJS from "exceljs";
import { parseSildelagetCatchWorkbook } from "../../src/sildelaget/catch-parser";

const HEADERS = [
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
];

describe("parseSildelagetCatchWorkbook", () => {
  test("parses repeated headers by index and groups duplicate ids", async () => {
    const buffer = await makeWorkbook([
      baseRow({
        innmeldingId: "1001",
        reportDate: "28.05.2026",
        reportTime: "10:30",
        fishingDate: "27.05.2026",
        fishingTime: "22:00",
        species: "NVG-sild",
        tonnes: "12,5",
        offerDate: "29.05.2026",
      }),
      baseRow({
        innmeldingId: "1001",
        reportDate: "28.05.2026",
        reportTime: "10:30",
        fishingDate: "28.05.2026",
        fishingTime: "01:00",
        species: "Makrell",
        tonnes: 3,
        offerDate: "30.05.2026",
      }),
      baseRow({
        innmeldingId: "1002",
        reportDate: "29.05.2026",
        reportTime: "11:00",
        fishingDate: "28.05.2026",
        fishingTime: "02:00",
        species: "NVG-sild",
        tonnes: 1.25,
        offerDate: "31.05.2026",
      }),
    ]);

    const entries = await parseSildelagetCatchWorkbook(buffer, {
      sourceUrl: "https://example.test/export.xlsx",
      checkedAt: "2026-05-29T12:00:00.000Z",
    });

    expect(entries).toHaveLength(2);
    const entry = entries.find((row) => row.innmeldingId === "1001");
    expect(entry?.reportedDate).toBe("2026-05-28");
    expect(entry?.reportedTime).toBe("10:30:00");
    expect(entry?.vesselName).toBe("Fiskebas");
    expect(entry?.registrationMark).toBe("FO-123");
    expect(entry?.lines).toHaveLength(2);
    expect(entry?.lines[0].offerEastSouthDate).toBe("2026-05-29");
    expect(entry?.lines.map((line) => line.species).sort()).toEqual([
      "Makrell",
      "NVG-sild",
    ]);
  });

  test("dedupes exact normalized lines and keeps stable hashes", async () => {
    const duplicate = baseRow({
      innmeldingId: "2001",
      reportDate: "01.06.2026",
      reportTime: "09:15",
      fishingDate: "31.05.2026",
      fishingTime: "23:45",
      species: "Kolmule",
      tonnes: "2,5",
      offerDate: "02.06.2026",
    });
    const buffer = await makeWorkbook([duplicate, duplicate]);

    const first = await parseSildelagetCatchWorkbook(buffer, {
      sourceUrl: "https://example.test/export.xlsx",
      checkedAt: "2026-06-01T10:00:00.000Z",
    });
    const second = await parseSildelagetCatchWorkbook(buffer, {
      sourceUrl: "https://example.test/export.xlsx",
      checkedAt: "2026-06-01T10:00:00.000Z",
    });

    expect(first).toHaveLength(1);
    expect(first[0].lines).toHaveLength(1);
    expect(first[0].lines[0].tonnes).toBe(2.5);
    expect(first[0].lines[0].weightKg).toBe(2500);
    expect(first[0].entryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first[0].lines[0].lineKey).toMatch(/^[a-f0-9]{64}$/);
    expect(first[0].entryHash).toBe(second[0].entryHash);
    expect(first[0].lines[0].lineKey).toBe(second[0].lines[0].lineKey);
  });
});

async function makeWorkbook(rows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Innmeldingsjournal");
  worksheet.addRow(HEADERS);
  for (const row of rows) worksheet.addRow(row);
  return Buffer.from((await workbook.xlsx.writeBuffer()) as ArrayBuffer);
}

function baseRow(input: {
  innmeldingId: string;
  reportDate: string;
  reportTime: string;
  fishingDate: string;
  fishingTime: string;
  species: string;
  tonnes: string | number;
  offerDate: string;
}): unknown[] {
  return [
    input.innmeldingId,
    input.reportDate,
    input.reportTime,
    input.fishingDate,
    input.fishingTime,
    input.species,
    "FO-123",
    "Fiskebas",
    "",
    "NO",
    "Torshavn",
    input.tonnes,
    "325",
    "Direkte",
    "Auksjon",
    "Not",
    "5",
    "Konsum",
    10,
    20,
    30,
    40,
    "Sortiment",
    "Ja",
    input.offerDate,
    "12:00",
    "Nei",
    "",
    "",
    "Ja",
    "",
    "",
    "Nei",
    "",
    "",
    "Samfisker",
    "Buyer AS",
    "Receiver AS",
    "NO",
  ];
}
