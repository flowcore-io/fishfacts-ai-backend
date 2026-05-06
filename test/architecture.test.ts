import { describe, expect, test } from "bun:test";

describe("architecture", () => {
  test("API routes do not write domain state directly", async () => {
    const appSource = await Bun.file("src/app.ts").text();
    expect(appSource).not.toContain(".insert(");
    expect(appSource).not.toContain(".update(");
    expect(appSource).not.toContain(".delete(");
  });

  test("J-melding scraper does not write Usable fragments directly", async () => {
    const scraperSource = await Bun.file(
      "src/jobs/fiskeridir-jmeldinger.ts",
    ).text();
    expect(scraperSource).not.toContain("UsableApiClient");
    expect(scraperSource).not.toContain("createFragment");
    expect(scraperSource).not.toContain("updateFragment");
    expect(scraperSource).toContain("writeJMeldingAnnouncement");
  });

  test("black-box tests do not import application internals", async () => {
    const proc = Bun.spawnSync({
      cmd: [
        "rg",
        "-n",
        "from [\"']@/|from [\"']\\.\\./src|from [\"']src/",
        "test",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(1);
  });
});
