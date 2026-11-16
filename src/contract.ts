/**
 * The HTTP contract. A request is the backend's LlmRequest (legal-notice-studio-backend/src/ai/provider.ts)
 * plus an optional `tier`; a response is its LlmResult. That is what makes switching the backend from
 * the Claude API to this service a small adapter instead of a rewrite.
 */
import { z } from "zod";

export const STEPS = ["triage", "extract", "extract_rerun", "transcribe", "summary", "plan", "draft", "assistant"] as const;
export const TIERS = ["fast", "balanced", "capable", "vision"] as const;
export type Step = (typeof STEPS)[number];
export type Tier = (typeof TIERS)[number];

const TextBlock = z.object({ type: z.literal("text"), text: z.string() });
const PdfBlock = z.object({ type: z.literal("pdf"), base64: z.string().min(1), title: z.string().optional() });
const ImageBlock = z.object({
  type: z.literal("image"),
  base64: z.string().min(1),
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
});
export const ContentBlock = z.discriminatedUnion("type", [TextBlock, PdfBlock, ImageBlock]);
export type ContentBlockT = z.infer<typeof ContentBlock>;

export const GenerateRequest = z.object({
  step: z.enum(STEPS),
  /** Optional: which model tier to use. Defaults from the step (see defaultTier). */
  tier: z.enum(TIERS).optional(),
  /** The model name the caller would have used (e.g. a Claude model) — informational only. */
  model: z.string().optional(),
  effort: z.string().optional(),
  /** Trusted instructions. */
  system: z.string(),
  /** Untrusted documents and the task, in order. */
  content: z.array(ContentBlock).min(1),
  /** JSON schema the answer must match. */
  schema: z.record(z.string(), z.unknown()),
  maxTokens: z.number().int().positive().max(64_000).optional(),
  promptVersion: z.string().optional(),
});
export type GenerateRequestT = z.infer<typeof GenerateRequest>;

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface GenerateResponse {
  json: unknown;
  /** Model configured for the tier (e.g. "legal-notice-reviewer"). */
  model: string;
  /** Model the runtime reports it actually ran. */
  servedBy: string;
  stopReason: "end_turn";
  usage: Usage;
  latencyMs: number;
  fallbackUsed: false;
  runtime: string;
  tier: Tier;
  /** Model calls made, including JSON repair attempts and one call per page for scans. */
  attempts: number;
}

export function defaultTier(step: Step): Tier {
  switch (step) {
    case "triage":
      return "fast";
    case "transcribe":
      return "vision";
    case "extract_rerun":
    case "draft":
      return "capable";
    default:
      return "balanced";
  }
}
