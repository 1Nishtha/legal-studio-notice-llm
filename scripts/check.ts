/**
 * Checks that the runtime and models work, without starting the HTTP server.
 *   npm run check                         # health + one small structured answer on each text tier
 *   npm run check -- --vision page.png    # also transcribe an image or PDF on the vision model
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, loadDotEnv } from "../src/config.js";
import { ServiceError } from "../src/errors.js";
import { createRuntime } from "../src/runtimes/index.js";
import { createService } from "../src/service.js";
import type { Tier } from "../src/contract.js";

loadDotEnv();
const config = loadConfig();
const service = createService({ config, runtime: createRuntime(config) });

const h = await service.health();
console.log(`runtime   ${h.runtime} ${h.base_url}${h.version ? ` v${h.version}` : ""} — ${h.reachable ? "reachable" : "NOT reachable"}`);
console.log(`models    ${JSON.stringify(h.models)}`);
if (h.hint) console.log(`hint      ${h.hint}`);
if (!h.reachable) process.exit(1);

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["is_notice", "agency", "deadline"],
  properties: {
    is_notice: { type: "boolean" },
    agency: { type: "string", description: "Issuing agency as written" },
    deadline: { type: "string", description: "Response deadline as YYYY-MM-DD, or empty" },
  },
};
const sample = "FROM: Texas Comptroller of Public Accounts. Notice of delinquent sales tax report for period 2026-Q3. Please file the missing report by December 4, 2026 to avoid penalties.";

let failed = false;
const tiers: Tier[] = [...new Set<Tier>(["fast", "balanced", "capable"])];
for (const tier of tiers) {
  try {
    const r = await service.generate({ step: "triage", tier, system: "You read government notices and answer only with the requested JSON.", content: [{ type: "text", text: sample }], schema, maxTokens: 256 });
    const tps = r.usage.output && r.latencyMs ? (r.usage.output / (r.latencyMs / 1000)).toFixed(1) : "?";
    console.log(`${tier.padEnd(9)} ${r.servedBy} — ${r.latencyMs} ms, ${r.usage.input} in / ${r.usage.output} out tokens (~${tps} tok/s overall) -> ${JSON.stringify(r.json)}`);
  } catch (e) {
    failed = true;
    console.log(`${tier.padEnd(9)} FAILED: ${e instanceof ServiceError ? `${e.kind}: ${e.message}` : (e as Error).message}`);
  }
}

const vi = process.argv.indexOf("--vision");
if (vi > 0 && process.argv[vi + 1]) {
  const file = path.resolve(process.argv[vi + 1]!);
  const bytes = readFileSync(file);
  const isPdf = file.toLowerCase().endsWith(".pdf");
  const mediaType = file.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  try {
    const r = await service.generate({
      step: "transcribe",
      system: "You transcribe scanned government notices exactly as written.",
      content: [isPdf ? { type: "pdf", base64: bytes.toString("base64") } : { type: "image", base64: bytes.toString("base64"), mediaType }, { type: "text", text: `Transcribe "${path.basename(file)}".` }],
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["pages", "legibility"],
        properties: { pages: { type: "array", items: { type: "object", additionalProperties: false, required: ["page", "text"], properties: { page: { type: "integer" }, text: { type: "string" } } } }, legibility: { type: "number" } },
      },
    });
    const out = r.json as { pages: { page: number; text: string }[]; legibility: number };
    console.log(`vision    ${r.servedBy} — ${out.pages.length} page(s) in ${r.latencyMs} ms, legibility ${out.legibility}`);
    console.log(out.pages.map((p) => `--- page ${p.page}\n${p.text.slice(0, 800)}`).join("\n"));
  } catch (e) {
    failed = true;
    console.log(`vision    FAILED: ${e instanceof ServiceError ? `${e.kind}: ${e.message}` : (e as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);
