import type { AuthContext } from "@/auth/types";

type CacheEntry = {
  value: AuthContext;
  expiresAt: number;
};

export class TokenCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs: number) {}

  get(token: string): AuthContext | undefined {
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(token);
      return undefined;
    }
    return entry.value;
  }

  set(token: string, value: AuthContext) {
    this.entries.set(token, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  clear() {
    this.entries.clear();
  }
}
