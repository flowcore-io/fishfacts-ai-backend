import { describe, expect, test } from "bun:test";
import {
  hasExpired,
  parseFaroeseValidityWindow,
  parseValidityDate,
  parseValidityEnd,
  parseValidityStart,
  withExpiry,
} from "./validity";

describe("parseValidityDate", () => {
  test("reads Fiskeridir's day-first dates", () => {
    expect(parseValidityDate("19.06.2025")?.iso).toBe(
      "2025-06-19T00:00:00.000Z",
    );
    expect(parseValidityDate("1/6/25")?.iso).toBe("2025-06-01T00:00:00.000Z");
  });

  test("reads Fiskistofa's ISO date with a bare zone suffix", () => {
    // `new Date("2026-08-03Z")` is Invalid Date, so this needs its own branch.
    expect(parseValidityDate("2026-08-03Z")?.iso).toBe(
      "2026-08-03T00:00:00.000Z",
    );
  });

  test("keeps a full timestamp as the instant it is", () => {
    const parsed = parseValidityDate("2026-08-03T19:00:00.000Z");
    expect(parsed?.iso).toBe("2026-08-03T19:00:00.000Z");
    expect(parsed?.dateOnly).toBe(false);
  });

  test("rejects junk instead of inventing a day", () => {
    expect(parseValidityDate("31.02.2025")).toBeUndefined();
    expect(parseValidityDate("í dag, hin 1")).toBeUndefined();
    expect(parseValidityDate("")).toBeUndefined();
    expect(parseValidityDate(undefined)).toBeUndefined();
  });
});

describe("validity window ends", () => {
  test("a bare end date lasts to the end of its day", () => {
    expect(parseValidityEnd("21.07.2025")).toBe("2025-07-21T23:59:59.999Z");
    expect(parseValidityStart("21.07.2025")).toBe("2025-07-21T00:00:00.000Z");
  });

  test("a notice is still in force on its Utløpsdato", () => {
    const noon = new Date("2025-07-21T12:00:00.000Z");
    expect(hasExpired("21.07.2025", noon)).toBe(false);
    expect(hasExpired("20.07.2025", noon)).toBe(true);
  });

  test("no end date never expires", () => {
    expect(hasExpired(undefined)).toBe(false);
    expect(hasExpired("")).toBe(false);
  });
});

describe("withExpiry", () => {
  const now = new Date("2026-07-31T00:00:00.000Z");

  test("a closed window archives whatever the source called it", () => {
    expect(withExpiry("current", "31.12.2023", now)).toBe("archived");
    expect(withExpiry("active", "2026-07-01Z", now)).toBe("archived");
  });

  test("an open window leaves the status alone", () => {
    expect(withExpiry("current", "31.12.2026", now)).toBe("current");
    expect(withExpiry("active", undefined, now)).toBe("active");
  });
});

describe("parseFaroeseValidityWindow", () => {
  // Verbatim from https://www.vorn.fo/fiskiveida/bradfeingis-veidibann/veidibann-nr-14-2026
  const body =
    "Við heimild í Løgtingslóg nr. 152 frá 23. desember 2019, § 59, ásetir " +
    "Fiskiveiðueftirlitið bráðfeingis veiðibann fyri trol, á eini leið í " +
    "vestara kanti á Munkagrunninum. 6104 N – 0700 W Veiðibannið er galdandi " +
    "frá í dag, hin 1. juli 2026 klokkan 23:00 til 29. juli 2026 klokkan 23:00.";

  test("reads both ends of the ban out of the Faroese prose", () => {
    expect(parseFaroeseValidityWindow(body)).toEqual({
      validFrom: "2026-07-01T23:00:00.000Z",
      validTo: "2026-07-29T23:00:00.000Z",
    });
  });

  test("does not mistake the legal basis date for the ban's start", () => {
    // "Løgtingslóg nr. 152 frá 23. desember 2019" precedes the window and is
    // not part of it.
    expect(parseFaroeseValidityWindow(body).validFrom).not.toContain("2019");
  });

  test("survives Vørn's doubled 'til'", () => {
    // Bans nr. 12 and 13 of 2026 both read "klokkan 23:00 til til 20. juli".
    expect(
      parseFaroeseValidityWindow(
        "Veiðibannið er galdandi frá í dag, hin 22. juni 2026 klokkan 23:00 " +
          "til til 20. juli 2026 klokkan 23:00.",
      ),
    ).toEqual({
      validFrom: "2026-06-22T23:00:00.000Z",
      validTo: "2026-07-20T23:00:00.000Z",
    });
  });

  test("returns nothing when the page states no window", () => {
    expect(parseFaroeseValidityWindow("Veiðibann fyri trol.")).toEqual({});
  });
});
