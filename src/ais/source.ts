import type { Env } from "@/env";
import { MysqlAisSource } from "./mysql-source";
import type { AisSource } from "./types";

/**
 * The swap seam. Today `mysql`; a future `kafka` source maps stream messages to
 * the same `AisFix` and slots in here without touching anything downstream.
 */
export function createAisSource(env: Env): AisSource {
  switch (env.AIS_SOURCE) {
    case "mysql":
      return new MysqlAisSource(env);
    case "kafka":
      throw new Error("AIS_SOURCE=kafka not implemented yet");
    default:
      throw new Error(`Unknown AIS_SOURCE: ${env.AIS_SOURCE}`);
  }
}
