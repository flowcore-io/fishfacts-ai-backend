type ReceivedCall = {
  method: string;
  path: string;
  authToken: string | null;
  application: string | null;
};

type UserInfo = {
  id: number;
  username: string;
  firstName: string;
  lastName: string;
  groupId: number;
  groupName: string | null;
  authorities: string[];
  fleets: { id: number; name: string }[];
  serviceProvidersId: number[];
  newsId: number[];
  eventsId: number[];
};

const DEFAULT_USER_INFO: UserInfo = {
  id: 13,
  username: "dmytro",
  firstName: "Dmytro",
  lastName: "Tykhonov",
  groupId: 18,
  groupName: null,
  authorities: ["FISHFACTS", "USER"],
  fleets: [{ id: 624, name: "test" }],
  serviceProvidersId: [27],
  newsId: [40, 41],
  eventsId: [320],
};

export class FakeFishfactsServer {
  private server?: Bun.Server<unknown>;
  private outage = false;
  readonly calls: ReceivedCall[] = [];
  readonly validTokens = new Map<string, UserInfo>();

  constructor(private readonly port: number) {}

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  addValidToken(token: string, user: Partial<UserInfo> = {}) {
    this.validTokens.set(token, { ...DEFAULT_USER_INFO, ...user });
  }

  simulateOutage() {
    this.outage = true;
  }

  restore() {
    this.outage = false;
  }

  clear() {
    this.calls.length = 0;
  }

  async start() {
    await this.stop();
    this.calls.length = 0;
    this.outage = false;
    this.server = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const url = new URL(request.url);
        const authToken = request.headers.get("x-auth-token");
        const application = request.headers.get("x-application");
        this.calls.push({
          method: request.method,
          path: url.pathname,
          authToken,
          application,
        });

        if (this.outage) {
          return Response.json(
            { error: "service_unavailable" },
            { status: 503 },
          );
        }

        if (
          url.pathname === "/api/v3/user/active" &&
          request.method === "GET"
        ) {
          if (!authToken) {
            return Response.json(
              { code: -1, message: "missing token" },
              { status: 400 },
            );
          }
          if (application !== "FISHFACTS") {
            return Response.json(
              { code: -1, message: "missing application header" },
              { status: 400 },
            );
          }
          const user = this.validTokens.get(authToken);
          if (!user) {
            return Response.json(
              { code: -1, errors: null, message: "unauthorized", data: null },
              { status: 401 },
            );
          }
          return Response.json({
            code: 0,
            errors: null,
            message: "",
            data: {
              token: authToken,
              name: user.username,
              userInfo: user,
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
