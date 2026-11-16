/**
 * Ollama native API (POST /api/chat). Chosen over Ollama's OpenAI-compatible endpoint because it
 * lets us set the context window (num_ctx) per request; the default is far too small for a
 * notice plus its instructions. Structured output: the JSON schema goes in `format`.
 */
import { ServiceError } from "../errors.js";
import { errorMessage, requestJson } from "./http.js";
import type { FetchLike, Runtime, RuntimeRequest, RuntimeResult } from "./types.js";

interface OllamaChatResponse {
  model?: string;
  message?: { role?: string; content?: string; thinking?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaRuntime implements Runtime {
  readonly name = "ollama";
  /** Models that rejected the `think` parameter; we stop sending it to them. */
  private readonly noThinkParam = new Set<string>();

  constructor(
    readonly baseUrl: string,
    private readonly keepAlive: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  async chat(req: RuntimeRequest): Promise<RuntimeResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.images?.length ? { images: m.images.map((i) => i.base64) } : {}),
      })),
      format: req.schema,
      stream: false,
      keep_alive: this.keepAlive,
      options: { temperature: req.temperature, num_ctx: req.numCtx, num_predict: req.maxTokens },
    };
    if (req.disableThinking && !this.noThinkParam.has(req.model)) body.think = false;

    let r = await requestJson(this.fetchImpl, `${this.baseUrl}/api/chat`, { method: "POST", body, timeoutMs: req.timeoutMs }, "Ollama");
    if (r.status >= 400 && "think" in body && /think/i.test(errorMessage(r.json, r.text))) {
      // This model does not accept the thinking switch: remember that and ask again without it.
      this.noThinkParam.add(req.model);
      delete body.think;
      r = await requestJson(this.fetchImpl, `${this.baseUrl}/api/chat`, { method: "POST", body, timeoutMs: req.timeoutMs }, "Ollama");
    }
    if (r.status >= 400) throw mapError(r.status, errorMessage(r.json, r.text), req.model);

    const j = r.json as OllamaChatResponse | null;
    if (!j || typeof j.message?.content !== "string") {
      throw new ServiceError("api", "Ollama returned an unexpected response", true, { sample: r.text.slice(0, 300) });
    }
    return {
      text: j.message.content,
      model: j.model ?? req.model,
      stopReason: j.done_reason === "length" ? "max_tokens" : "end_turn",
      inputTokens: j.prompt_eval_count ?? 0,
      outputTokens: j.eval_count ?? 0,
    };
  }

  async listModels(): Promise<string[]> {
    const r = await requestJson(this.fetchImpl, `${this.baseUrl}/api/tags`, { method: "GET", timeoutMs: 5000 }, "Ollama");
    if (r.status >= 400) throw mapError(r.status, errorMessage(r.json, r.text), "");
    return ((r.json as { models?: { name?: string }[] } | null)?.models ?? []).map((m) => m.name ?? "").filter(Boolean);
  }

  async version(): Promise<string | null> {
    try {
      const r = await requestJson(this.fetchImpl, `${this.baseUrl}/api/version`, { method: "GET", timeoutMs: 5000 }, "Ollama");
      return (r.json as { version?: string } | null)?.version ?? null;
    } catch {
      return null;
    }
  }
}

function mapError(status: number, msg: string, model: string): ServiceError {
  if (status === 404 || /not found/i.test(msg)) {
    return new ServiceError("not_configured", `Model "${model}" is not available in Ollama — create or pull it (see README: "Set up the models")`, false, { ollama: msg });
  }
  if (/memory|cuda|out of vram/i.test(msg)) {
    return new ServiceError("overloaded", `Ollama could not load "${model}" (${msg}). Try a smaller model or a smaller NUM_CTX.`, true, { ollama: msg });
  }
  if (status >= 500) return new ServiceError("overloaded", `Ollama error ${status}: ${msg}`, true);
  return new ServiceError("bad_request", `Ollama rejected the request (${status}): ${msg}`, false);
}
