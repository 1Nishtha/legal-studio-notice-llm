import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MockRuntime } from "../src/runtimes/mock.js";
import { createService } from "../src/service.js";
import { testConfig, TRIAGE_SCHEMA } from "./helpers.js";

function app(overrides: Record<string, string> = {}, runtime = new MockRuntime()) {
  const config = testConfig(overrides);
  return buildApp({ config, service: createService({ config, runtime }), logger: false });
}

const request = { step: "triage", model: "claude-haiku-5-5", effort: "low", system: "Classify.", content: [{ type: "text", text: "A notice." }], schema: TRIAGE_SCHEMA, maxTokens: 4000, promptVersion: "triage@abc" };

describe("HTTP API", () => {
  it("GET /health reports readiness", async () => {
    const res = await app().inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, runtime: "mock" });
  });

  it("POST /v1/generate accepts the backend's LlmRequest unchanged and answers in its LlmResult shape", async () => {
    const res = await app().inject({ method: "POST", url: "/v1/generate", payload: request });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body)).toEqual(expect.arrayContaining(["json", "model", "servedBy", "stopReason", "usage", "latencyMs", "fallbackUsed"]));
    expect(body.json).toMatchObject({ is_candidate: false, category: "tax_notice", agency_guess: null });
  });

  it("rejects malformed requests with bad_request", async () => {
    const res = await app().inject({ method: "POST", url: "/v1/generate", payload: { step: "triage", content: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ kind: "bad_request", retryable: false });
  });

  it("requires the service token when one is configured", async () => {
    const a = app({ LLM_SERVICE_TOKEN: "s3cret" });
    expect((await a.inject({ method: "POST", url: "/v1/generate", payload: request })).statusCode).toBe(401);
    expect((await a.inject({ method: "POST", url: "/v1/generate", payload: request, headers: { authorization: "Bearer wrong!" } })).statusCode).toBe(401);
    expect((await a.inject({ method: "POST", url: "/v1/generate", payload: request, headers: { authorization: "Bearer s3cret" } })).statusCode).toBe(200);
  });

  it("maps model failures to the backend's error kinds and HTTP statuses", async () => {
    const res = await app({}, new MockRuntime(() => ({ text: "{", stopReason: "max_tokens" }))).inject({ method: "POST", url: "/v1/generate", payload: request });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ kind: "max_tokens", retryable: true });
  });
});
