import { describe, expect, it } from "vitest";
import { ServiceError } from "../src/errors.js";
import { OllamaRuntime } from "../src/runtimes/ollama.js";
import { OpenAICompatibleRuntime } from "../src/runtimes/openai.js";
import type { RuntimeRequest } from "../src/runtimes/types.js";
import { fakeFetch, jsonResponse, TRIAGE_SCHEMA } from "./helpers.js";

const baseReq = (over: Partial<RuntimeRequest> = {}): RuntimeRequest => ({
  model: "legal-notice-reviewer",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "read this", images: [{ base64: "QUJD", mime: "image/jpeg" }] },
  ],
  schema: TRIAGE_SCHEMA,
  maxTokens: 900,
  temperature: 0,
  numCtx: 16384,
  timeoutMs: 5000,
  disableThinking: true,
  ...over,
});

async function expectError(p: Promise<unknown>): Promise<ServiceError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ServiceError);
    return e as ServiceError;
  }
  throw new Error("expected an error");
}

describe("OllamaRuntime", () => {
  it("sends the schema as `format`, the context size and images, with thinking off", async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ model: "legal-notice-reviewer:latest", message: { role: "assistant", content: '{"ok":true}' }, done_reason: "stop", prompt_eval_count: 120, eval_count: 7 }));
    const r = await new OllamaRuntime("http://127.0.0.1:11434", "30m", fetchImpl).chat(baseReq());
    expect(calls[0]!.url).toBe("http://127.0.0.1:11434/api/chat");
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ model: "legal-notice-reviewer", format: TRIAGE_SCHEMA, stream: false, keep_alive: "30m", think: false, options: { temperature: 0, num_ctx: 16384, num_predict: 900 } });
    expect((body.messages as { images?: string[] }[])[1]!.images).toEqual(["QUJD"]);
    expect((body.messages as { images?: string[] }[])[0]!.images).toBeUndefined();
    expect(r).toEqual({ text: '{"ok":true}', model: "legal-notice-reviewer:latest", stopReason: "end_turn", inputTokens: 120, outputTokens: 7 });
  });

  it("reports a cut-off answer as max_tokens", async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ message: { content: '{"a":' }, done_reason: "length" }));
    expect((await new OllamaRuntime("http://x", "5m", fetchImpl).chat(baseReq())).stopReason).toBe("max_tokens");
  });

  it("retries without the thinking switch when a model rejects it, and remembers", async () => {
    const { fetchImpl, calls } = fakeFetch((_u, body) =>
      (body as { think?: boolean }).think === false ? jsonResponse({ error: '"gemma3:4b" does not support thinking' }, 400) : jsonResponse({ message: { content: "{}" }, done_reason: "stop" }),
    );
    const rt = new OllamaRuntime("http://x", "5m", fetchImpl);
    await rt.chat(baseReq({ model: "gemma3:4b" }));
    await rt.chat(baseReq({ model: "gemma3:4b" }));
    expect(calls.map((c) => "think" in (c.body as object))).toEqual([true, false, false]);
  });

  it("maps a missing model to not_configured (not retryable)", async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ error: 'model "legal-notice-reviewer" not found, try pulling it first' }, 404));
    const e = await expectError(new OllamaRuntime("http://x", "5m", fetchImpl).chat(baseReq()));
    expect(e.kind).toBe("not_configured");
    expect(e.retryable).toBe(false);
  });

  it("maps 'Ollama not running' to a retryable overloaded error and timeouts to timeout", async () => {
    const refused = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    const e1 = await expectError(new OllamaRuntime("http://127.0.0.1:11434", "5m", refused).chat(baseReq()));
    expect(e1.kind).toBe("overloaded");
    expect(e1.retryable).toBe(true);
    expect(e1.message).toContain("ECONNREFUSED");

    const slow = async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    const e2 = await expectError(new OllamaRuntime("http://x", "5m", slow).chat(baseReq()));
    expect(e2.kind).toBe("timeout");
  });

  it("lists installed models", async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ models: [{ name: "legal-notice-reviewer:latest" }, { name: "gemma3:4b" }] }));
    expect(await new OllamaRuntime("http://x", "5m", fetchImpl).listModels()).toEqual(["legal-notice-reviewer:latest", "gemma3:4b"]);
  });
});

describe("OpenAICompatibleRuntime", () => {
  it("uses response_format json_schema, data-URL images and the API key", async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ model: "qwen", choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 2 } }));
    const r = await new OpenAICompatibleRuntime("http://127.0.0.1:8080/v1", "sk-local", fetchImpl).chat(baseReq());
    const c = calls[0]!;
    expect(c.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(c.headers.authorization).toBe("Bearer sk-local");
    const body = c.body as { response_format: unknown; max_tokens: number; messages: { content: unknown }[] };
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "answer", schema: TRIAGE_SCHEMA, strict: true } });
    expect(body.max_tokens).toBe(900);
    expect(body.messages[1]!.content).toEqual([
      { type: "text", text: "read this" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
    ]);
    expect(r).toMatchObject({ text: "{}", stopReason: "end_turn", inputTokens: 50, outputTokens: 2 });
  });

  it("maps 401 to auth and finish_reason length to max_tokens", async () => {
    const { fetchImpl: denied } = fakeFetch(() => jsonResponse({ error: { message: "bad key" } }, 401));
    expect((await expectError(new OpenAICompatibleRuntime("http://x/v1", "", denied).chat(baseReq()))).kind).toBe("auth");
    const { fetchImpl: cut } = fakeFetch(() => jsonResponse({ choices: [{ message: { content: "{" }, finish_reason: "length" }] }));
    expect((await new OpenAICompatibleRuntime("http://x/v1", "", cut).chat(baseReq())).stopReason).toBe("max_tokens");
  });
});
