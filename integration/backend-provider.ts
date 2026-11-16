/**
 * Drop-in LlmProvider for legal-notice-studio-backend: sends every AI step to the local LLM
 * service (legal-notice-studio-llm) instead of the Claude API. The request is the backend's own
 * LlmRequest plus a model tier; errors come back with the backend's LlmErrorKind values, so its
 * retry rules and "route to a person" fallbacks keep working unchanged.
 *
 * NOT USED YET — the app runs on the Claude API. To switch (see ../README.md, "Switch the app to
 * your model"):
 *   1. Copy this file to legal-notice-studio-backend/src/ai/local.ts
 *   2. In legal-notice-studio-backend/src/ai/run.ts:
 *        import { LocalLlmProvider } from "./local.js";
 *        let provider: LlmProvider = config.AI_PROVIDER === "local" ? new LocalLlmProvider() : new AnthropicProvider();
 *   3. In legal-notice-studio-backend/.env: AI_PROVIDER=local (LOCAL_LLM_URL / LOCAL_LLM_TOKEN if not default)
 *   4. Restart the backend; run `npm run eval` there to compare quality with Claude before relying on it.
 */
import { config } from "../config.js";
import { LlmError, type LlmErrorKind, type LlmProvider, type LlmRequest, type LlmResult } from "./provider.js";

const KINDS: readonly LlmErrorKind[] = ["not_configured", "refusal", "max_tokens", "invalid_json", "bad_request", "auth", "rate_limit", "overloaded", "timeout", "api"];

interface ServiceAnswer {
  json?: unknown;
  servedBy?: string;
  stopReason?: string;
  usage?: LlmResult["usage"];
  latencyMs?: number;
  error?: { kind?: string; message?: string; retryable?: boolean; details?: Record<string, unknown> };
}

export class LocalLlmProvider implements LlmProvider {
  readonly name = "local";
  readonly configured = true;

  constructor(
    private readonly baseUrl = (process.env.LOCAL_LLM_URL || "http://127.0.0.1:4100").replace(/\/+$/, ""),
    private readonly token = process.env.LOCAL_LLM_TOKEN || "",
    /** Keep below the job queue's 10-minute stale-job window (src/workflow/queue.ts). */
    private readonly timeoutMs = Number(process.env.LOCAL_LLM_TIMEOUT_MS || 540_000),
  ) {}

  async generate(req: LlmRequest): Promise<LlmResult> {
    // The backend picks a model per step (fast / balanced / most capable); the service maps tiers to local models.
    const tier = req.step === "transcribe" ? "vision" : req.model === config.MODEL_TRIAGE ? "fast" : req.model === config.MODEL_REASON ? "capable" : "balanced";
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/generate`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify({ ...req, tier }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError";
      throw new LlmError(
        timedOut ? "timeout" : "overloaded",
        timedOut ? `Local LLM service did not answer within ${Math.round(this.timeoutMs / 1000)} s` : `Local LLM service is not reachable at ${this.baseUrl} — start it with "npm run dev" in legal-notice-studio-llm`,
        true,
        undefined,
        undefined,
        Date.now() - started,
      );
    }
    const body = (await res.json().catch(() => null)) as ServiceAnswer | null;
    if (!res.ok || !body || body.error) {
      const e = body?.error ?? {};
      const kind = KINDS.includes(e.kind as LlmErrorKind) ? (e.kind as LlmErrorKind) : "api";
      throw new LlmError(kind, e.message ?? `Local LLM service error ${res.status}`, e.retryable ?? res.status >= 500, e.details, undefined, Date.now() - started);
    }
    return {
      json: body.json,
      model: req.model,
      servedBy: body.servedBy ?? "local",
      stopReason: body.stopReason ?? "end_turn",
      usage: body.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      latencyMs: body.latencyMs ?? Date.now() - started,
      fallbackUsed: false,
    };
  }
}
