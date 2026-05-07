export class FakeFiskeridirServer {
  private server?: Bun.Server<unknown>;
  private extraDetailParagraph = "";

  constructor(private readonly port: number) {}

  get baseUrl() {
    return `http://127.0.0.1:${this.port}/yrkesfiske/j-meldinger`;
  }

  setLargeDetailBody(charCount: number, marker = "X") {
    this.extraDetailParagraph = `<p>${marker.repeat(charCount)}</p>`;
  }

  clearLargeDetailBody() {
    this.extraDetailParagraph = "";
  }

  async start(statusText = "current") {
    await this.stop();
    this.server = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/yrkesfiske/j-meldinger") {
          return new Response(
            `<html><body><main>
              <a class="list-view-j-message" href="/yrkesfiske/j-meldinger/j-1-2026">
                <h3>J-1-2026 Testregulering for fisket etter sild</h3>
                <span>${statusText}</span>
              </a>
            </main></body></html>`,
            { headers: { "content-type": "text/html" } },
          );
        }
        if (url.pathname === "/yrkesfiske/j-meldinger/j-1-2026") {
          return new Response(
            `<html><body><main>
              <h1>J-1-2026 Testregulering for fisket etter sild</h1>
              <p>Gjeldende J-melding.</p>
              <p>Gyldig fra 01.01.2026</p>
              <p>Dette er en testkunngjøring for fisket etter sild.</p>
              ${this.extraDetailParagraph}
            </main></body></html>`,
            { headers: { "content-type": "text/html" } },
          );
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
