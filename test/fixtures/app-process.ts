export class AppProcess {
  private proc?: Bun.Subprocess<"ignore", "pipe", "pipe">;

  constructor(
    private readonly port: number,
    private readonly env: Record<string, string>,
  ) {}

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  async start() {
    await this.stop();
    this.proc = Bun.spawn(["bun", "src/index.ts"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...this.env,
        PORT: String(this.port),
      },
    });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.baseUrl}/health`);
        if (response.ok) return;
      } catch {
        await Bun.sleep(100);
      }
    }
    const stderr = this.proc.stderr
      ? await new Response(this.proc.stderr).text().catch(() => "")
      : "";
    throw new Error(`App did not start: ${stderr}`);
  }

  async stop() {
    if (!this.proc) return;
    this.proc.kill();
    await this.proc.exited.catch(() => undefined);
    this.proc = undefined;
  }

  fetch(path: string, init: RequestInit = {}) {
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init.headers,
      },
    });
  }
}
