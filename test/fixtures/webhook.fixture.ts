import { type Mock, jest } from "bun:test";
import { randomUUID } from "node:crypto";

export type RecordedWebhook = {
  eventId: string;
  tenant: string;
  dataCore: string;
  flowType: string;
  eventType: string;
  payload: unknown;
  metadata: Record<string, unknown>;
};

export class WebhookTestFixture {
  private server?: Bun.Server<unknown>;
  readonly events: RecordedWebhook[] = [];
  readonly spies = new Map<string, Mock<(...args: unknown[]) => void>>();

  constructor(
    private readonly options: {
      port: number;
      secret: string;
      transformerUrl: string;
    },
  ) {}

  addEndpoint(
    flowType: string,
    eventType: string,
    redirectToTransformer = false,
  ) {
    const key = `${flowType}/${eventType}`;
    this.spies.set(key, jest.fn());
    this.routes.set(key, redirectToTransformer);
    return this;
  }

  private readonly routes = new Map<string, boolean>();

  async start() {
    await this.stop();
    this.clear();
    this.server = Bun.serve({
      port: this.options.port,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        const match = url.pathname.match(
          /^\/event\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/,
        );
        if (!match)
          return Response.json({ error: "not_found" }, { status: 404 });
        const [, tenant, dataCore, flowType, eventType] = match;
        const routeKey = `${flowType}/${eventType}`;
        if (!this.routes.has(routeKey)) {
          return Response.json({ error: "unknown_event" }, { status: 404 });
        }
        const payload = await request.json().catch(() => null);
        const eventId = randomUUID();
        const validTime =
          request.headers.get("x-flowcore-valid-time") ??
          new Date().toISOString();
        const metadata = request.headers.get("x-flowcore-metadata-json")
          ? JSON.parse(
              Buffer.from(
                request.headers.get("x-flowcore-metadata-json") as string,
                "base64",
              ).toString("utf-8"),
            )
          : {};
        const event = {
          eventId,
          flowType,
          dataCoreId: dataCore,
          tenant,
          timeBucket: validTime.slice(0, 13).replace(/\D/g, "").padEnd(14, "0"),
          eventType,
          validTime,
          payload,
          metadata,
        };
        if (this.routes.get(routeKey)) {
          const response = await fetch(this.options.transformerUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-secret": this.options.secret,
            },
            body: JSON.stringify(event),
          });
          if (!response.ok) {
            return Response.json(
              { error: "transformer_failed", body: await response.text() },
              { status: 500 },
            );
          }
        }
        this.events.push({
          eventId,
          tenant,
          dataCore,
          flowType,
          eventType,
          payload,
          metadata,
        });
        this.spies.get(routeKey)?.(payload, metadata);
        return Response.json({ eventId });
      },
    });
  }

  async stop() {
    await this.server?.stop();
    this.server = undefined;
  }

  clear() {
    this.events.length = 0;
    for (const spy of this.spies.values()) spy.mockClear();
  }

  last(flowType: string, eventType: string) {
    return this.events.findLast(
      (event) => event.flowType === flowType && event.eventType === eventType,
    );
  }
}
