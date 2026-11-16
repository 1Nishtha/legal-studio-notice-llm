/**
 * Any OpenAI-compatible chat-completions server: llama.cpp `llama-server`, vLLM, LM Studio,
 * or a GPU server elsewhere. Structured output via response_format json_schema.
 */
import { ServiceError } from "../errors.js";
import { errorMessage, requestJson } from "./http.js";
import type { FetchLike, Runtime, RuntimeRequest, RuntimeResult } from "./types.js";

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAICompatibleRuntime implements Runtime {
  readonly name = "openai";

  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  private headers(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  async chat(req: RuntimeRequest): Promise<RuntimeResult> {
    const messages = req.messages.map((m) =>
      m.images?.length
        ? {
            role: m.role,
            content: [{ type: "text", text: m.content }, ...m.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.base64}` } }))],
          }
        : { role: m.role, content: m.content },
    );
    const body = {
      model: req.model,
      messages,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      response_format: { type: "json_schema", json_schema: { name: "answer", schema: req.schema, strict: true } },
    };
    const r = await requestJson(this.fetchImpl, `${this.baseUrl}/chat/completions`, { method: "POST", body, headers: this.headers(), timeoutMs: req.timeoutMs }, "Model server");
    if (r.status >= 400) throw mapError(r.status, errorMessage(r.json, r.text), req.model);
    const j = r.json as ChatCompletion | null;
    const choice = j?.choices?.[0];
    if (!choice || typeof choice.message?.content !== "string") {
      throw new ServiceError("api", "Model server returned an unexpected response", true, { sample: r.text.slice(0, 300) });
    }
    return {
      text: choice.message.content,
      model: j?.model ?? req.model,
      stopReason: choice.finish_reason === "length" ? "max_tokens" : "end_turn",
      inputTokens: j?.usage?.prompt_tokens ?? 0,
      outputTokens: j?.usage?.completion_tokens ?? 0,
    };
  }

  async listModels(): Promise<string[]> {
    const r = await requestJson(this.fetchImpl, `${this.baseUrl}/models`, { method: "GET", headers: this.headers(), timeoutMs: 5000 }, "Model server");
    if (r.status >= 400) throw mapError(r.status, errorMessage(r.json, r.text), "");
    return ((r.json as { data?: { id?: string }[] } | null)?.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  }

  async version(): Promise<string | null> {
    return null;
  }
}

function mapError(status: number, msg: string, model: string): ServiceError {
  if (status === 401 || status === 403) return new ServiceError("auth", `Model server refused the credentials (${status}): ${msg}`, false);
  if (status === 404) return new ServiceError("not_configured", `Model "${model}" is not served at this address: ${msg}`, false);
  if (status === 429) return new ServiceError("rate_limit", `Model server is busy (429): ${msg}`, true);
  if (status >= 500) return new ServiceError("overloaded", `Model server error ${status}: ${msg}`, true);
  return new ServiceError("bad_request", `Model server rejected the request (${status}): ${msg}`, false);
}
