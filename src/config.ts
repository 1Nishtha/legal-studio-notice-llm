/**
 * Configuration from environment variables (.env in this folder). Every value has a default,
 * so the service starts with no .env at all.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4100),
  HOST: z.string().default("127.0.0.1"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Optional shared secret; when set, callers must send "Authorization: Bearer <token>". */
  LLM_SERVICE_TOKEN: z.string().default(""),

  /** ollama = Ollama native API | openai = any OpenAI-compatible server (llama.cpp, vLLM, LM Studio) | mock = no model, schema-valid placeholders */
  RUNTIME: z.enum(["ollama", "openai", "mock"]).default("ollama"),
  OLLAMA_BASE_URL: z.string().url().default("http://127.0.0.1:11434"),
  OPENAI_BASE_URL: z.string().url().default("http://127.0.0.1:8080/v1"),
  OPENAI_API_KEY: z.string().default(""),

  /** Model per tier. The backend's steps map to tiers: triage=fast, extraction/summary/plan=balanced, re-run/drafts=capable, scans=vision. */
  MODEL_FAST: z.string().min(1).default("legal-notice-reviewer"),
  MODEL_BALANCED: z.string().min(1).default("legal-notice-reviewer"),
  MODEL_CAPABLE: z.string().min(1).default("legal-notice-reviewer"),
  MODEL_VISION: z.string().min(1).default("legal-notice-reader"),

  /** Context window in tokens (prompt + answer). Larger needs more GPU/CPU memory. */
  NUM_CTX: z.coerce.number().int().min(2048).default(16384),
  TEMPERATURE: z.coerce.number().min(0).max(2).default(0),
  /** How long Ollama keeps a model loaded after a request (e.g. 30m, 2h, -1 = forever). */
  KEEP_ALIVE: z.string().default("30m"),
  /** Ask "thinking" models (e.g. Qwen3) to answer directly; ignored by models that cannot think. */
  DISABLE_THINKING: bool.default(true),
  /** Per model call; stays below the backend job queue's 10-minute stale-job window. */
  TIMEOUT_MS: z.coerce.number().int().min(1000).default(480_000),
  /** Simultaneous model calls; 1 is right for a single consumer GPU. */
  MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  /** Hard cap on answer length, whatever the caller asks for. */
  MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).default(8192),
  /** Write a readable outline of the JSON schema into the prompt (small models need to see it). */
  SCHEMA_IN_PROMPT: bool.default(true),
  /** Extra attempts when the answer is not valid JSON for the schema. */
  REPAIR_RETRIES: z.coerce.number().int().min(0).max(3).default(1),

  VISION_MAX_PAGES: z.coerce.number().int().min(1).default(20),
  /** Longest side in pixels for page images and photos sent to the vision model. */
  VISION_MAX_SIDE: z.coerce.number().int().min(512).max(4096).default(1400),
  MAX_BODY_MB: z.coerce.number().int().min(1).default(60),
});

export type Config = z.infer<typeof EnvSchema>;

/** Parse configuration from an environment map (empty strings count as "not set"). */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = EnvSchema.safeParse(clean);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  return parsed.data;
}

/** Load ./.env into process.env (variables already set in the shell win). */
export function loadDotEnv(): void {
  const file = path.join(ROOT, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}
