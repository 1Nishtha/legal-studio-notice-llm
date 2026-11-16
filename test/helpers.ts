import { loadConfig, type Config } from "../src/config.js";
import type { FetchLike } from "../src/runtimes/types.js";

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    RUNTIME: "mock",
    MODEL_FAST: "m-fast",
    MODEL_BALANCED: "m-balanced",
    MODEL_CAPABLE: "m-capable",
    MODEL_VISION: "m-vision",
    LOG_LEVEL: "silent",
    ...overrides,
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fetch stand-in that records requests and answers with `handler`. */
export function fakeFetch(handler: (url: string, body: unknown, callIndex: number) => Response | Promise<Response>) {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body, headers: (init?.headers as Record<string, string>) ?? {} });
    return handler(url, body, calls.length - 1);
  };
  return { fetchImpl, calls };
}

/** Schema in the backend's shape for triage (enum + nullable union + list). */
export const TRIAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_candidate", "category", "agency_guess", "confidence", "reasons"],
  properties: {
    is_candidate: { type: "boolean" },
    category: { type: "string", enum: ["tax_notice", "regulatory_notice", "other"] },
    agency_guess: { anyOf: [{ type: "string" }, { type: "null" }] },
    confidence: { type: "number" },
    reasons: { type: "array", items: { type: "string" } },
  },
};

/** The backend's transcription schema. */
export const TRANSCRIBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pages", "legibility"],
  properties: {
    pages: { type: "array", items: { type: "object", additionalProperties: false, required: ["page", "text"], properties: { page: { type: "integer" }, text: { type: "string" } } } },
    legibility: { type: "number" },
  },
};
