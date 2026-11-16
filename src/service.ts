/**
 * The model service: one request in the backend's LlmRequest shape -> one schema-valid JSON answer.
 *
 *  - Routes the step to a model tier (fast / balanced / capable / vision).
 *  - Writes a readable outline of the JSON schema into the system prompt and lets the runtime
 *    constrain the output to the schema.
 *  - Validates every answer; when it is not valid JSON for the schema, asks the model once more
 *    with the validation errors (REPAIR_RETRIES).
 *  - Keeps prompt + answer inside the context window instead of letting the runtime silently
 *    cut the beginning of the prompt (which would drop the instructions).
 *  - Scans: renders PDF pages / normalizes photos and transcribes them page by page on the
 *    vision model, then returns { pages: [{ page, text }], legibility } like the backend expects.
 */
import type { Config } from "./config.js";
import { defaultTier, type GenerateRequestT, type GenerateResponse, type Tier, type Usage } from "./contract.js";
import { ServiceError } from "./errors.js";
import { parseModelJson } from "./json.js";
import { Limiter } from "./limiter.js";
import { describeErrors, schemaOutline, validatorFor, type JsonSchema } from "./schema-tools.js";
import type { Runtime, RuntimeImage, RuntimeMessage } from "./runtimes/types.js";
import { normalizeImage, pdfToImages } from "./vision.js";

/** Rough token estimate used only for the context-window guard (no tokenizer needed). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.2);
}
const TOKENS_PER_IMAGE = 1200;
const MIN_ANSWER_TOKENS = 512;

export interface Health {
  ok: boolean;
  runtime: string;
  base_url: string;
  reachable: boolean;
  version: string | null;
  models: Record<Tier, string>;
  missing: string[];
  installed: string[];
  hint: string | null;
  error?: string;
}

export interface Service {
  generate(req: GenerateRequestT): Promise<GenerateResponse>;
  health(): Promise<Health>;
  readonly models: Record<Tier, string>;
}

const MODELFILES: Record<string, string> = {
  "legal-notice-reviewer": "models/legal-notice-reviewer.Modelfile",
  "legal-notice-reader": "models/legal-notice-reader.Modelfile",
};

const sameModel = (a: string, b: string) => a.replace(/:latest$/, "") === b.replace(/:latest$/, "");
const clamp01 = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

export function createService({ config, runtime }: { config: Config; runtime: Runtime }): Service {
  const limiter = new Limiter(config.MAX_CONCURRENCY);
  const models: Record<Tier, string> = {
    fast: config.MODEL_FAST,
    balanced: config.MODEL_BALANCED,
    capable: config.MODEL_CAPABLE,
    vision: config.MODEL_VISION,
  };

  function systemWithSchema(system: string, schema: JsonSchema): string {
    if (!config.SCHEMA_IN_PROMPT) return system;
    return [
      system.trim(),
      "",
      "## Output format",
      "Answer with one JSON object and nothing else: no prose, no code fences. It must have exactly this structure:",
      schemaOutline(schema),
    ].join("\n");
  }

  /** One schema-valid answer from the model, with up to REPAIR_RETRIES repair attempts. */
  async function complete(args: { tier: Tier; system: string; user: string; images: RuntimeImage[]; schema: JsonSchema; maxTokens: number }) {
    const model = models[args.tier];
    const validate = validatorFor(args.schema);
    const messages: RuntimeMessage[] = [
      { role: "system", content: systemWithSchema(args.system, args.schema) },
      { role: "user", content: args.user, ...(args.images.length ? { images: args.images } : {}) },
    ];
    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let lastError: ServiceError | null = null;

    for (let attempt = 1; attempt <= 1 + config.REPAIR_RETRIES; attempt++) {
      const promptTokens = messages.reduce((n, m) => n + estimateTokens(m.content) + (m.images?.length ?? 0) * TOKENS_PER_IMAGE, 0);
      const room = config.NUM_CTX - promptTokens - 64;
      if (room < MIN_ANSWER_TOKENS) {
        throw new ServiceError(
          "bad_request",
          `The input (~${promptTokens} tokens) does not fit the context window (NUM_CTX=${config.NUM_CTX}) with room for an answer. Raise NUM_CTX or send fewer pages.`,
          false,
          { promptTokens, numCtx: config.NUM_CTX },
        );
      }
      const maxTokens = Math.min(args.maxTokens, config.MAX_OUTPUT_TOKENS, room);

      const r = await limiter.run(() =>
        runtime.chat({
          model,
          messages,
          schema: args.schema,
          maxTokens,
          temperature: config.TEMPERATURE,
          numCtx: config.NUM_CTX,
          timeoutMs: config.TIMEOUT_MS,
          disableThinking: config.DISABLE_THINKING,
        }),
      );
      usage.input += r.inputTokens;
      usage.output += r.outputTokens;
      if (r.stopReason === "max_tokens") {
        throw new ServiceError("max_tokens", `The answer hit the ${maxTokens}-token limit before the JSON was complete`, true, { model: r.model });
      }

      let json: unknown;
      try {
        json = parseModelJson(r.text);
      } catch (e) {
        lastError = e as ServiceError;
        messages.push({ role: "assistant", content: r.text }, { role: "user", content: "That was not valid JSON. Answer again with only the JSON object." });
        continue;
      }
      if (validate(json)) return { json, servedBy: r.model, usage, attempts: attempt };
      const why = describeErrors(validate);
      lastError = new ServiceError("invalid_json", `Model output did not match the schema: ${why}`, true, { sample: r.text.slice(0, 300) });
      messages.push(
        { role: "assistant", content: r.text },
        { role: "user", content: `That JSON does not match the required structure (${why}). Answer again with the corrected JSON object only.` },
      );
    }
    throw lastError ?? new ServiceError("invalid_json", "Model output was not valid", true);
  }

  async function generate(req: GenerateRequestT): Promise<GenerateResponse> {
    const started = Date.now();
    if (req.step === "transcribe") return transcribe(req, started);

    const tier = req.tier ?? defaultTier(req.step);
    const texts = req.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
    const visuals = req.content.length - texts.length;
    let user = texts.join("\n\n");
    if (visuals) {
      user += `\n\n(Note: ${visuals} scanned original(s) were attached for visual reference, but this text model cannot see images; rely on the transcribed text above.)`;
    }
    const r = await complete({ tier, system: req.system, user, images: [], schema: req.schema, maxTokens: req.maxTokens ?? 4096 });
    return {
      json: r.json,
      model: models[tier],
      servedBy: r.servedBy,
      stopReason: "end_turn",
      usage: r.usage,
      latencyMs: Date.now() - started,
      fallbackUsed: false,
      runtime: runtime.name,
      tier,
      attempts: r.attempts,
    };
  }

  const PAGE_SCHEMA: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["text", "legibility"],
    properties: {
      text: { type: "string", description: "Everything legible on this page, in reading order, copied exactly" },
      legibility: { type: "number", description: "0..1 — how legible the page is (1 = perfectly clear)" },
    },
  };

  async function transcribe(req: GenerateRequestT, started: number): Promise<GenerateResponse> {
    const tier = req.tier ?? "vision";
    const images: RuntimeImage[] = [];
    for (const b of req.content) {
      const room = config.VISION_MAX_PAGES - images.length;
      if (room <= 0) break;
      if (b.type === "pdf") images.push(...(await pdfToImages(b.base64, { maxPages: room, width: config.VISION_MAX_SIDE })).images);
      else if (b.type === "image") images.push(await normalizeImage(b.base64, config.VISION_MAX_SIDE));
    }
    if (!images.length) throw new ServiceError("bad_request", "The transcribe step needs at least one pdf or image block", false);

    const task = req.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
    const system = `${req.system.trim()}\n\nYou receive one page image at a time. Transcribe only that page.`;
    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const pages: { page: number; text: string; legibility: number }[] = [];
    let servedBy = models[tier];
    let attempts = 0;
    for (let i = 0; i < images.length; i++) {
      const r = await complete({
        tier,
        system,
        user: `${task ? `${task}\n\n` : ""}This image is page ${i + 1} of ${images.length}.`,
        images: [images[i]!],
        schema: PAGE_SCHEMA,
        maxTokens: Math.min(req.maxTokens ?? 4096, 4096),
      });
      const out = r.json as { text: string; legibility: number };
      pages.push({ page: i + 1, text: out.text, legibility: clamp01(out.legibility) });
      usage.input += r.usage.input;
      usage.output += r.usage.output;
      attempts += r.attempts;
      servedBy = r.servedBy;
    }

    const json = { pages: pages.map(({ page, text }) => ({ page, text })), legibility: Math.min(...pages.map((p) => p.legibility)) };
    const validate = validatorFor(req.schema);
    if (!validate(json)) {
      throw new ServiceError("bad_request", `The transcribe step answers { pages: [{ page, text }], legibility }, which does not match the requested schema (${describeErrors(validate)})`, false);
    }
    return { json, model: models[tier], servedBy, stopReason: "end_turn", usage, latencyMs: Date.now() - started, fallbackUsed: false, runtime: runtime.name, tier, attempts };
  }

  async function health(): Promise<Health> {
    const needed = [...new Set(Object.values(models))];
    try {
      const [installed, version] = await Promise.all([runtime.listModels(), runtime.version()]);
      const has = (m: string) => installed.includes("*") || installed.some((i) => sameModel(i, m));
      const missing = needed.filter((m) => !has(m));
      const hint = missing.length
        ? `Missing model(s): ${missing.map((m) => (MODELFILES[m] && runtime.name === "ollama" ? `ollama create ${m} -f ${MODELFILES[m]}` : runtime.name === "ollama" ? `ollama pull ${m}` : m)).join("  |  ")}`
        : null;
      return { ok: missing.length === 0, runtime: runtime.name, base_url: runtime.baseUrl, reachable: true, version, models, missing, installed: installed.filter((x) => x !== "*"), hint };
    } catch (e) {
      return {
        ok: false,
        runtime: runtime.name,
        base_url: runtime.baseUrl,
        reachable: false,
        version: null,
        models,
        missing: needed,
        installed: [],
        hint: runtime.name === "ollama" ? "Start Ollama (open the Ollama app, or run `ollama serve`)" : `Start the model server at ${runtime.baseUrl}`,
        error: (e as Error).message,
      };
    }
  }

  return { generate, health, models };
}
