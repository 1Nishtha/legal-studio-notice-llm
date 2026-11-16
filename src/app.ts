/**
 * HTTP API:
 *   GET  /health        runtime reachable? models installed? (no token needed; no secrets in it)
 *   GET  /v1/models     tier -> model mapping and what the runtime has installed
 *   POST /v1/generate   the backend's LlmRequest (+ optional tier) -> LlmResult-shaped answer
 * Errors: { error: { kind, message, retryable } } with kinds identical to the backend's LlmErrorKind.
 */
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { GenerateRequest } from "./contract.js";
import { ServiceError } from "./errors.js";
import type { Service } from "./service.js";

export function buildApp({ config, service, logger = true }: { config: Config; service: Service; logger?: boolean }): FastifyInstance {
  const app = Fastify({
    logger: logger ? { level: config.LOG_LEVEL } : false,
    bodyLimit: config.MAX_BODY_MB * 1024 * 1024,
  });

  const authorized = (header: string | undefined): boolean => {
    if (!config.LLM_SERVICE_TOKEN) return true;
    const want = Buffer.from(`Bearer ${config.LLM_SERVICE_TOKEN}`);
    const got = Buffer.from(header ?? "");
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const deny = () => new ServiceError("auth", "Missing or wrong service token (Authorization: Bearer <LLM_SERVICE_TOKEN>)", false);

  app.get("/health", async () => service.health());

  app.get("/v1/models", async (req, reply) => {
    if (!authorized(req.headers.authorization)) return reply.code(401).send({ error: deny().toJSON() });
    const h = await service.health();
    return { runtime: h.runtime, tiers: h.models, installed: h.installed, missing: h.missing };
  });

  app.post("/v1/generate", async (req, reply) => {
    if (!authorized(req.headers.authorization)) return reply.code(401).send({ error: deny().toJSON() });
    const parsed = GenerateRequest.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues
        .slice(0, 6)
        .map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`)
        .join("; ");
      return reply.code(400).send({ error: new ServiceError("bad_request", `Invalid request — ${msg}`, false).toJSON() });
    }
    try {
      const res = await service.generate(parsed.data);
      req.log.info({ step: parsed.data.step, tier: res.tier, model: res.servedBy, ms: res.latencyMs, tokens: res.usage, attempts: res.attempts }, "generated");
      return res;
    } catch (e) {
      const err = e instanceof ServiceError ? e : new ServiceError("api", (e as Error).message || "Unexpected error", true);
      req.log.warn({ step: parsed.data.step, kind: err.kind }, err.message);
      return reply.code(err.status).send({ error: err.toJSON() });
    }
  });

  return app;
}
