import JSZip from "jszip";

export const SILDELAGET_HEADERS = [
  "Innmeldingsid",
  "Dato",
  "Kl",
  "Start fiske",
  "Tidspunkt",
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

export type SildelagetWorkbookRow = Array<string | number | null>;

export async function makeSildelagetNamespacedWorkbook(
  rows: SildelagetWorkbookRow[],
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
  );
  zip.folder("_rels")?.file(
    ".rels",
    `<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="RWorkbook" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
  );
  zip.folder("xl")?.file(
    "workbook.xml",
    `<?xml version="1.0" encoding="utf-8"?>
<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <x:sheets>
    <x:sheet name="Innmeldingsjournal" sheetId="1" r:id="RSheet1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
  </x:sheets>
</x:workbook>`,
  );
  zip
    .folder("xl")
    ?.folder("_rels")
    ?.file(
      "workbook.xml.rels",
      `<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="RSheet1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
    );
  zip
    .folder("xl")
    ?.folder("worksheets")
    ?.file(
      "sheet1.xml",
      `<?xml version="1.0" encoding="utf-8"?>
<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <x:sheetData>
${[SILDELAGET_HEADERS, ...rows]
  .map(
    (row, index) => `    <x:row r="${index + 1}">
${row.map((cell) => renderCell(cell)).join("\n")}
    </x:row>`,
  )
  .join("\n")}
  </x:sheetData>
</x:worksheet>`,
    );
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

export function sildelagetFixtureRow(input: {
  innmeldingId: string;
  reportDateSerial?: number;
  reportTimeSerial?: number;
  fishingDateSerial?: number;
  fishingTimeSerial?: number;
  species: string;
  registrationMark?: string;
  vesselName?: string;
  tonnes: number;
  buyer?: string;
  receiver?: string;
}): SildelagetWorkbookRow {
  return [
    input.innmeldingId,
    input.reportDateSerial ?? 46170,
    input.reportTimeSerial ?? 0.5,
    input.fishingDateSerial ?? 46169,
    input.fishingTimeSerial ?? 0.25,
    input.species,
    input.registrationMark ?? "FO-123",
    input.vesselName ?? "Fiskebas",
    "",
    "Norsk",
    "",
    input.tonnes,
    120,
    "DIREKTE",
    "AUKSJON",
    "Kystnot",
    "4214",
    "FRYSING",
    null,
    null,
    null,
    null,
    "",
    "",
    null,
    null,
    "",
    null,
    null,
    "",
    null,
    null,
    "",
    null,
    null,
    "",
    input.buyer ?? "Buyer AS",
    input.receiver ?? "Receiver AS",
    "NO",
  ];
}

export class FakeSildelagetServer {
  private server?: Bun.Server<unknown>;
  private workbook: Uint8Array = new Uint8Array();
  private routeAreas: Record<string, unknown> = {};
  readonly calls: string[] = [];

  constructor(private readonly port: number) {}

  get exportUrl() {
    return `${this.baseUrl}/umbraco/api/catchjournal/ExportCatchJournal`;
  }

  get catchAreasUrl() {
    return `${this.baseUrl}/catchmap/MapService.svc/CatchAreas`;
  }

  private get baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  setWorkbook(workbook: Uint8Array) {
    this.workbook = workbook;
  }

  setRouteAreas(routeAreas: Record<string, unknown>) {
    this.routeAreas = routeAreas;
  }

  async start() {
    await this.stop();
    this.calls.length = 0;
    this.server = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        this.calls.push(`${url.pathname}?${url.searchParams.toString()}`);
        if (url.pathname === "/catchmap/MapService.svc/CatchAreas") {
          return Response.json(this.routeAreas);
        }
        const routeMatch = url.pathname.match(
          /^\/catchmap\/MapService\.svc\/CatchAreas\/(.+)$/,
        );
        if (routeMatch) {
          const route = routeMatch[1].replace(/^#/, "").padStart(4, "0");
          const key = `#${route}`;
          return Response.json(
            this.routeAreas[key] ? { [key]: this.routeAreas[key] } : {},
          );
        }
        if (url.pathname === "/umbraco/api/catchjournal/ExportCatchJournal") {
          return new Response(this.workbook as unknown as BodyInit, {
            headers: {
              "content-type":
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            },
          });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });
  }

  async stop() {
    await this.server?.stop();
    this.server = undefined;
  }
}

function renderCell(value: string | number | null): string {
  if (value === null) return "      <x:c/>";
  if (typeof value === "number") {
    return `      <x:c t="n"><x:v>${value}</x:v></x:c>`;
  }
  return `      <x:c t="str"><x:v>${escapeXml(value)}</x:v></x:c>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
