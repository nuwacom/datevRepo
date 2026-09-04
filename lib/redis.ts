// lib/redis.ts
// Lazy ioredis client (RESP protocol) against the Redis sidecar in the same
// Container App (or Azure Cache for Redis, same interface). Construction MUST
// stay lazy: env vars may be absent at build time (next build evaluates route
// modules), and /healthz needs to be able to report missing config instead of
// crashing at import. Callers use r.get/r.set/r.eval exactly as before
// (@upstash/redis and ioredis share that surface); JSON values are
// (de)serialized here since ioredis, unlike @upstash/redis, only stores strings.

import { Redis } from "ioredis";
import { required } from "@/lib/datevEnv";

let client: Redis | null = null;

export function redis(): Redis {
  if (!client) {
    client = new Redis(required("REDIS_URL"), { lazyConnect: false });
  }
  return client;
}

// Thin adapter matching the handful of @upstash/redis calls this project used,
// so lib/datevAuth.ts didn't need to change.
export interface RedisOps {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { ex?: number; nx?: true; px?: number }): Promise<string | null>;
  getdel<T>(key: string): Promise<T | null>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

function ops(r: Redis): RedisOps {
  return {
    async get<T>(key: string) {
      const raw = await r.get(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    },
    async set(key: string, value: unknown, opts?: { ex?: number; nx?: true; px?: number }) {
      const serialized = JSON.stringify(value);
      if (opts?.nx && opts.px) return r.set(key, serialized, "PX", opts.px, "NX");
      if (opts?.ex) return r.set(key, serialized, "EX", opts.ex);
      return r.set(key, serialized);
    },
    async getdel<T>(key: string) {
      const raw = await r.call("GETDEL", key) as string | null;
      return raw === null || raw === undefined ? null : (JSON.parse(raw) as T);
    },
    eval(script, keys, args) {
      return r.eval(script, keys.length, ...keys, ...args);
    },
  };
}

// Wrap every Redis operation so connectivity problems surface as one
// self-diagnosing message instead of an opaque connection error.
export async function safeRedis<T>(op: (r: RedisOps) => Promise<T>): Promise<T> {
  try {
    return await op(ops(redis()));
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (msg.startsWith("Missing required environment variable")) {
      throw err;
    }
    throw new Error(`Redis unavailable (check REDIS_URL): ${msg}`);
  }
}
