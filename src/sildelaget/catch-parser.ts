import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { SildelagetCatchEntryObserved } from "@/events/contracts";
import * as ExcelJS from "exceljs";

const COLUMNS = {
  innmeldingId: 0,
  reportedDate: 1,
  reportedTime: 2,
  fishingStartDate: 3,
  fishingStartTime: 4,
  species: 5,
  registrationMark: 6,
  vesselName: 7,
  leasedVessel: 8,
  economicZone: 9,
  municipality: 10,
  tonnes: 11,
  average: 12,
  catchType: 13,
  salesType: 14,
  gear: 15,
  route: 16,
  use: 17,
  pct1: 18,
  pct2: 19,
  pct3: 20,
  pct4: 21,
  assortment: 22,
  offerEastSouth: 23,
  offerEastSouthDate: 24,
  offerEastSouthTime: 25,
  offerEastNorth: 26,
  offerEastNorthDate: 27,
  offerEastNorthTime: 28,
  offerWestSouth: 29,
  offerWestSouthDate: 30,
  offerWestSouthTime: 31,
  offerWestNorth: 32,
  offerWestNorthDate: 33,
  offerWestNorthTime: 34,
  coFisher: 35,
  buyer: 36,
  receiver: 37,
  nationality: 38,
} as const;

const RAW_KEYS = Object.keys(COLUMNS) as Array<keyof typeof COLUMNS>;

type ParserOptions = {
  sourceUrl: string;
  checkedAt: string;
};

type LineBase = Omit<
  SildelagetCatchEntryObserved["lines"][number],
  "lineKey" | "lineIndex"
>;

type EntryAccumulator = Omit<
  SildelagetCatchEntryObserved,
  "entryHash" | "lines"
> & {
  linesByFingerprint: Map<string, LineBase>;
};

export async function parseSildelagetCatchWorkbook(
  input: Buffer | ArrayBuffer | Uint8Array,
  options: ParserOptions,
): Promise<SildelagetCatchEntryObserved[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(toBuffer(input) as never);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];

  const byInnmeldingId = new Map<string, EntryAccumulator>();

  worksheet.eachRow((row) => {
    const innmeldingId = textCell(row, COLUMNS.innmeldingId);
    if (!innmeldingId || innmeldingId.toLowerCase() === "innmeldingsid") {
      return;
    }

    const reportedDate = dateCell(row, COLUMNS.reportedDate);
    const reportedTime = timeCell(row, COLUMNS.reportedTime);
    const registrationMark = textCell(row, COLUMNS.registrationMark);
    const vesselName = textCell(row, COLUMNS.vesselName);
    const rawRow = rawRowObject(row);

    let entry = byInnmeldingId.get(innmeldingId);
    if (!entry) {
      entry = {
        innmeldingId,
        reportedDate,
        reportedTime,
        vesselName,
        registrationMark,
        sourceUrl: options.sourceUrl,
        checkedAt: options.checkedAt,
        rawEntry: {
          innmeldingId,
          reportedDate,
          reportedTime,
          vesselName,
          registrationMark,
          firstRowNumber: row.number,
        },
        linesByFingerprint: new Map(),
      };
      byInnmeldingId.set(innmeldingId, entry);
    }

    const line: LineBase = {
      fishingStartDate: dateCell(row, COLUMNS.fishingStartDate),
      fishingStartTime: timeCell(row, COLUMNS.fishingStartTime),
      species: textCell(row, COLUMNS.species),
      tonnes: numberCell(row, COLUMNS.tonnes),
      weightKg: kgFromTonnes(numberCell(row, COLUMNS.tonnes)),
      average: numberCell(row, COLUMNS.average),
      catchType: textCell(row, COLUMNS.catchType),
      salesType: textCell(row, COLUMNS.salesType),
      gear: textCell(row, COLUMNS.gear),
      route: textCell(row, COLUMNS.route),
      use: textCell(row, COLUMNS.use),
      pct1: numberCell(row, COLUMNS.pct1),
      pct2: numberCell(row, COLUMNS.pct2),
      pct3: numberCell(row, COLUMNS.pct3),
      pct4: numberCell(row, COLUMNS.pct4),
      assortment: textCell(row, COLUMNS.assortment),
      offerEastSouth: textCell(row, COLUMNS.offerEastSouth),
      offerEastSouthDate: dateCell(row, COLUMNS.offerEastSouthDate),
      offerEastSouthTime: timeCell(row, COLUMNS.offerEastSouthTime),
      offerEastNorth: textCell(row, COLUMNS.offerEastNorth),
      offerEastNorthDate: dateCell(row, COLUMNS.offerEastNorthDate),
      offerEastNorthTime: timeCell(row, COLUMNS.offerEastNorthTime),
      offerWestSouth: textCell(row, COLUMNS.offerWestSouth),
      offerWestSouthDate: dateCell(row, COLUMNS.offerWestSouthDate),
      offerWestSouthTime: timeCell(row, COLUMNS.offerWestSouthTime),
      offerWestNorth: textCell(row, COLUMNS.offerWestNorth),
      offerWestNorthDate: dateCell(row, COLUMNS.offerWestNorthDate),
      offerWestNorthTime: timeCell(row, COLUMNS.offerWestNorthTime),
      leasedVessel: textCell(row, COLUMNS.leasedVessel),
      economicZone: textCell(row, COLUMNS.economicZone),
      municipality: textCell(row, COLUMNS.municipality),
      coFisher: textCell(row, COLUMNS.coFisher),
      buyer: textCell(row, COLUMNS.buyer),
      receiver: textCell(row, COLUMNS.receiver),
      nationality: textCell(row, COLUMNS.nationality),
      rawRow,
    };
    const fingerprint = stableStringify(line);
    if (!entry.linesByFingerprint.has(fingerprint)) {
      entry.linesByFingerprint.set(fingerprint, line);
    }
  });

  return Array.from(byInnmeldingId.values()).map((entry) => {
    const sortedLinePairs = Array.from(entry.linesByFingerprint.entries()).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    const lines = sortedLinePairs.map(([, line], lineIndex) => ({
      lineKey: sha256(`${entry.innmeldingId}:${stableStringify(line)}`),
      lineIndex,
      ...line,
    }));
    const entryData = {
      innmeldingId: entry.innmeldingId,
      reportedDate: entry.reportedDate,
      reportedTime: entry.reportedTime,
      vesselName: entry.vesselName,
      registrationMark: entry.registrationMark,
      lines: lines.map(
        ({ lineIndex: _lineIndex, lineKey: _lineKey, ...line }) => line,
      ),
    };
    return {
      innmeldingId: entry.innmeldingId,
      reportedDate: entry.reportedDate,
      reportedTime: entry.reportedTime,
      vesselName: entry.vesselName,
      registrationMark: entry.registrationMark,
      entryHash: sha256(stableStringify(entryData)),
      sourceUrl: entry.sourceUrl,
      checkedAt: entry.checkedAt,
      rawEntry: {
        ...entry.rawEntry,
        lineCount: lines.length,
      },
      lines,
    };
  });
}

function toBuffer(input: Buffer | ArrayBuffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

function textCell(row: ExcelJS.Row, index: number): string | null {
  return normalizeText(row.getCell(index + 1).value);
}

function dateCell(row: ExcelJS.Row, index: number): string | null {
  return normalizeDate(row.getCell(index + 1).value);
}

function timeCell(row: ExcelJS.Row, index: number): string | null {
  return normalizeTime(row.getCell(index + 1).value);
}

function numberCell(row: ExcelJS.Row, index: number): number | null {
  return normalizeNumber(row.getCell(index + 1).value);
}

function rawRowObject(row: ExcelJS.Row): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of RAW_KEYS) {
    raw[key] = normalizeRaw(row.getCell(COLUMNS[key] + 1).value);
  }
  return raw;
}

function normalizeRaw(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return value;
  return normalizeText(value);
}

function normalizeText(value: unknown): string | null {
  const text = cellValueToString(value)
    ?.replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text : null;
}

function cellValueToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.richText)) {
    return record.richText
      .map((part) =>
        typeof part === "object" && part !== null
          ? String((part as Record<string, unknown>).text ?? "")
          : "",
      )
      .join("");
  }
  for (const key of ["text", "result", "hyperlink"]) {
    if (typeof record[key] === "string" || typeof record[key] === "number") {
      return String(record[key]);
    }
  }
  return null;
}

function normalizeDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDate(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return formatDate(excelSerialToDate(value));
  }
  const text = normalizeText(value);
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const norwegian = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (norwegian) {
    const day = norwegian[1].padStart(2, "0");
    const month = norwegian[2].padStart(2, "0");
    const rawYear = Number(norwegian[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    return `${year}-${month}-${day}`;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : formatDate(parsed);
}

function normalizeTime(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatTime(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const fraction = value - Math.floor(value);
    return formatSeconds(Math.round(fraction * 24 * 60 * 60));
  }
  const text = normalizeText(value);
  if (!text) return null;
  const match = text.match(/^(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? 0);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0",
  )}:${String(seconds).padStart(2, "0")}`;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = normalizeText(value);
  if (!text) return null;
  const compact = text
    .replace(/%$/, "")
    .replace(/\s/g, "")
    .replace(/\.(?=.*,\d+$)/g, "")
    .replace(",", ".");
  const parsed = Number.parseFloat(compact);
  return Number.isFinite(parsed) ? parsed : null;
}

function kgFromTonnes(tonnes: number | null): number | null {
  return tonnes === null ? null : tonnes * 1000;
}

function excelSerialToDate(serial: number): Date {
  const days = Math.floor(serial);
  return new Date(Date.UTC(1899, 11, 30) + days * 24 * 60 * 60 * 1000);
}

function formatDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(
    2,
    "0",
  )}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function formatTime(date: Date): string {
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(
    date.getUTCMinutes(),
  ).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")}`;
}

function formatSeconds(totalSeconds: number): string {
  const normalized = ((totalSeconds % 86400) + 86400) % 86400;
  const hours = Math.floor(normalized / 3600);
  const minutes = Math.floor((normalized % 3600) / 60);
  const seconds = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0",
  )}:${String(seconds).padStart(2, "0")}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
