// lib/redis.ts
// Lazy Upstash Redis client. Construction MUST stay lazy: env vars may be absent
// at build time (next build evaluates route modules), and /healthz needs to be
// able to report missing config instead of crashing at import.

import { Redis } from "@upstash/redis";
import { required } from "@/lib/datevEnv";

let client: Redis | null = null;

export function redis(): Redis {
  if (!client) {
    client = new Redis({
      url: required("UPSTASH_REDIS_REST_URL"),
      token: required("UPSTASH_REDIS_REST_TOKEN"),
    });
  }
  return client;
}

// Wrap every Redis operation so connectivity problems surface as one
// self-diagnosing message instead of an opaque fetch error.
export async function safeRedis<T>(op: (r: Redis) => Promise<T>): Promise<T> {
  try {
    return await op(redis());
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (msg.startsWith("Missing required environment variable")) {
      throw err;
    }
    throw new Error(
      `Redis unavailable (check UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN): ${msg}`
    );
  }
}
