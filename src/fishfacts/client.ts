import type { FishfactsUser } from "@/auth/types";
import type { Env } from "@/env";

export type FishfactsValidationResult =
  | { ok: true; user: FishfactsUser }
  | {
      ok: false;
      reason: "invalid_token" | "upstream_error" | "invalid_response";
    };

const REQUEST_TIMEOUT_MS = 5000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseUser(value: unknown): FishfactsUser | null {
  const obj = asRecord(value);
  if (!obj) return null;
  if (typeof obj.id !== "number") return null;
  if (typeof obj.username !== "string") return null;
  return {
    id: obj.id,
    username: obj.username,
    firstName: typeof obj.firstName === "string" ? obj.firstName : "",
    lastName: typeof obj.lastName === "string" ? obj.lastName : "",
    groupId: typeof obj.groupId === "number" ? obj.groupId : 0,
    groupName: typeof obj.groupName === "string" ? obj.groupName : null,
    authorities: Array.isArray(obj.authorities)
      ? obj.authorities.filter((v): v is string => typeof v === "string")
      : [],
    fleets: Array.isArray(obj.fleets)
      ? obj.fleets
          .map((f) => asRecord(f))
          .filter((f): f is Record<string, unknown> => f !== null)
          .map((f) => ({
            id: typeof f.id === "number" ? f.id : 0,
            name: typeof f.name === "string" ? f.name : "",
          }))
      : [],
    serviceProvidersId: Array.isArray(obj.serviceProvidersId)
      ? obj.serviceProvidersId.filter((v): v is number => typeof v === "number")
      : [],
    newsId: Array.isArray(obj.newsId)
      ? obj.newsId.filter((v): v is number => typeof v === "number")
      : [],
    eventsId: Array.isArray(obj.eventsId)
      ? obj.eventsId.filter((v): v is number => typeof v === "number")
      : [],
  };
}

export class FishfactsApiClient {
  constructor(private readonly env: Env) {}

  async validateToken(token: string): Promise<FishfactsValidationResult> {
    let response: Response;
    try {
      response = await fetch(
        `${this.env.FISHFACTS_API_BASE_URL}/api/v3/user/active`,
        {
          method: "GET",
          headers: {
            accept: "*/*",
            "x-auth-token": token,
            "X-Application": this.env.FISHFACTS_APPLICATION,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch (error) {
      console.error("[Auth] Upstream fishfacts request failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, reason: "upstream_error" };
    }

    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "invalid_token" };
    }

    if (!response.ok) {
      console.error("[Auth] Upstream fishfacts non-2xx response", {
        status: response.status,
      });
      return { ok: false, reason: "upstream_error" };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: "invalid_response" };
    }

    const root = asRecord(body);
    const code = root?.code;
    const data = asRecord(root?.data);
    const userInfo = parseUser(data?.userInfo);

    if (code !== 0 || !userInfo) {
      if (code === undefined && !userInfo) {
        return { ok: false, reason: "invalid_response" };
      }
      return { ok: false, reason: "invalid_token" };
    }

    return { ok: true, user: userInfo };
  }
}
