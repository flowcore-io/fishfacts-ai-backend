import { describe, expect, test } from "bun:test";
import { withExpiry } from "@/jmelding/validity";
import {
  detectStatus,
  extractDataListValue,
  extractValidity,
} from "./fiskeridir-jmeldinger";

// The metadata header that opens every J-melding page, verbatim from
// https://www.fiskeridir.no/yrkesfiske/j-meldinger/j-99-2025 (an expired
// notice). The `<time>` cells are what the dates should be read from.
const J_99_2025_HEADER = `
  <h1 class="page">J-99-2025: Forskrift om endring i forskrift om regulering av fiske med snurrevad</h1>
  <dl class="fd-datalist">
    <div class="data-list-item">
      <dt class="term">Status</dt>
      <dd class="category icon-start icon-status-red icon-red">Utgått</dd>
    </div>
    <div class="data-list-item">
      <dt class="term">Gyldig fra og med</dt>
      <dd class="icon-start icon-calendar"><time datetime="2025-06-19">19.06.2025</time></dd>
    </div>
    <div class="data-list-item">
      <dt class="term">Utløpsdato</dt>
      <dd class="icon-start icon-calendar"><time datetime="2025-07-21">21.07.2025</time></dd>
    </div>
  </dl>
`;

// The body of the same notice, as `stripTags` leaves it. It contains the word
// that used to decide the classification — and the footer link that would
// decide it the other way round if the body were scanned archived-first.
const J_99_2025_BODY =
  "J-99-2025: Forskrift om endring i forskrift om regulering av fiske med snurrevad " +
  "Status Utgått Gyldig fra og med 19.06.2025 Utløpsdato 21.07.2025 " +
  "Fastsatt av Fiskeridirektoratet 19. juni 2025 med hjemmel i lov 6. juni 2008 nr. 37 " +
  "I forskrift 4. mars 2021 gjøres følgende endringer: § 3 oppheves. " +
  "Gjeldende §§ 4 og 5 blir §§ 3 og 4. " +
  "Endringer Se utgåtte meldinger";

describe("detectStatus", () => {
  test("an explicit Utgått beats a Gjeldende that is only legal prose", () => {
    // The old order returned "current" here: it tested the current markers
    // first, over the whole body, and "Gjeldende §§ 4 og 5 blir §§ 3 og 4" won.
    const field = extractDataListValue(J_99_2025_HEADER, "Status");
    expect(field).toBe("Utgått");
    expect(detectStatus(field ?? J_99_2025_BODY, "unknown")).toBe("archived");
  });

  test("classifies a listing row from its own link text", () => {
    // Listing link text carries the window and the status word at the end.
    const expired =
      "J-114-2023 Forskrift om forbud mot å fiske reker i NAFO-området i 2023 " +
      "Gyldig fra og med 07.07.2023 Utløpsdato 31.12.2023 Utgått";
    const current =
      "J-127-2026 Forskrift om stenging av området nord for 70 grader nord " +
      "Gyldig fra og med 31.07.2026 Gyldig til og med 13.08.2026 Gjeldende";
    expect(detectStatus(expired, "unknown")).toBe("archived");
    expect(detectStatus(current, "unknown")).toBe("current");
  });

  test("a notice whose window has not opened yet is still live", () => {
    // "Kommende" — adopted, starts in 2027. It is not superseded, so it files
    // as current and `valid_from` keeps it out of "in force now" reads.
    const upcoming =
      "J-29-2026 Midlertidig forskrift om automatiske vekter " +
      "Gyldig fra og med 01.01.2027 Gyldig til og med 01.01.2028 Kommende";
    expect(detectStatus(upcoming, "unknown")).toBe("current");
  });

  test("falls back when the text carries no status word at all", () => {
    expect(detectStatus("J-1-2026 Forskrift om regulering", "unknown")).toBe(
      "unknown",
    );
  });
});

describe("extractValidity", () => {
  test("reads the end date under either label", () => {
    expect(
      extractValidity("Gyldig fra og med 07.07.2023 Utløpsdato 31.12.2023"),
    ).toEqual({ validFrom: "07.07.2023", validTo: "31.12.2023" });
    expect(
      extractValidity(
        "Gyldig fra og med 31.07.2026 Gyldig til og med 13.08.2026",
      ),
    ).toEqual({ validFrom: "31.07.2026", validTo: "13.08.2026" });
  });

  test("an open-ended notice has a start and no end", () => {
    expect(extractValidity("Gyldig fra og med 24.07.2026 Gjeldende")).toEqual({
      validFrom: "24.07.2026",
      validTo: undefined,
    });
  });
});

describe("extractDataListValue", () => {
  test("prefers the machine-readable date over the rendered one", () => {
    expect(extractDataListValue(J_99_2025_HEADER, "Gyldig fra og med")).toBe(
      "2025-06-19",
    );
    expect(extractDataListValue(J_99_2025_HEADER, "Utløpsdato")).toBe(
      "2025-07-21",
    );
  });

  test("is absent rather than wrong when the label is not on the page", () => {
    expect(
      extractDataListValue(J_99_2025_HEADER, "Gyldig til og med"),
    ).toBeUndefined();
  });
});

describe("J-99-2025 end to end", () => {
  test("the notice Gilli was shown as current files as archived", () => {
    const status = detectStatus(
      extractDataListValue(J_99_2025_HEADER, "Status") ?? J_99_2025_BODY,
      "unknown",
    );
    const validTo = extractDataListValue(J_99_2025_HEADER, "Utløpsdato");
    expect(withExpiry(status, validTo, new Date("2026-07-31T00:00:00Z"))).toBe(
      "archived",
    );
  });

  test("its expiry date alone would have been enough", () => {
    // Even if the status word had been missed, the date contradicts it.
    expect(
      withExpiry("current", "21.07.2025", new Date("2026-07-31T00:00:00Z")),
    ).toBe("archived");
  });
});
