/** Entry point: config -> runtime -> service -> HTTP server, then a health report. */
import { buildApp } from "./app.js";
import { loadConfig, loadDotEnv } from "./config.js";
import { createRuntime } from "./runtimes/index.js";
import { createService } from "./service.js";

loadDotEnv();
const config = loadConfig();
const runtime = createRuntime(config);
const service = createService({ config, runtime });
const app = buildApp({ config, service });

await app.listen({ port: config.PORT, host: config.HOST });

const h = await service.health();
const lines = [
  "",
  "  Legal Notice Studio — local LLM service",
  `  - listening on   http://${config.HOST}:${config.PORT}   (POST /v1/generate, GET /health)`,
  `  - runtime        ${runtime.name}${runtime.name === "mock" ? "  (NO MODEL — placeholder answers for wiring tests only)" : ` at ${runtime.baseUrl}${h.version ? ` (v${h.version})` : ""}`}`,
  `  - models         fast=${h.models.fast}  balanced=${h.models.balanced}  capable=${h.models.capable}  vision=${h.models.vision}`,
  `  - context        ${config.NUM_CTX} tokens, ${config.MAX_CONCURRENCY} request(s) at a time`,
  `  - status         ${h.ok ? "READY" : h.reachable ? "runtime reachable, but some models are missing" : "runtime NOT reachable"}`,
  ...(h.hint ? [`  - next step      ${h.hint}`] : []),
  "",
];
console.log(lines.join("\n"));

const stop = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
