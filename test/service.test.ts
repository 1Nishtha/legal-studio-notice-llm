import { readFileSync } from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { ServiceError } from "../src/errors.js";
import { MockRuntime } from "../src/runtimes/mock.js";
import type { Runtime } from "../src/runtimes/types.js";
import { createService } from "../src/service.js";
import { testConfig, TRANSCRIBE_SCHEMA, TRIAGE_SCHEMA } from "./helpers.js";

const VALID_TRIAGE = JSON.stringify({ is_candidate: true, category: "tax_notice", agency_guess: "IRS", confidence: 0.9, reasons: ["CP2000 wording"] });
const text = (t: string) => ({ type: "text" as const, text: t });

async function expectError(p: Promise<unknown>): Promise<ServiceError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ServiceError);
    return e as ServiceError;
  }
  throw new Error("expected an error");
}

describe("generate", () => {
  it("routes each step to its tier model and shows the schema in the system prompt", async () => {
    const runtime = new MockRuntime();
    const svc = createService({ config: testConfig(), runtime });
    const steps = { triage: "m-fast", extract: "m-balanced", summary: "m-balanced", plan: "m-balanced", extract_rerun: "m-capable", draft: "m-capable" } as const;
    for (const [step, model] of Object.entries(steps)) {
      const r = await svc.generate({ step: step as keyof typeof steps, system: "Be exact.", content: [text("notice text")], schema: TRIAGE_SCHEMA });
      expect(r.model).toBe(model);
      expect(runtime.calls.at(-1)!.model).toBe(model);
    }
    // explicit tier wins over the step default
    expect((await svc.generate({ step: "summary", tier: "capable", system: "s", content: [text("x")], schema: TRIAGE_SCHEMA })).model).toBe("m-capable");
    const sys = runtime.calls[0]!.messages[0]!.content;
    expect(sys).toContain("Be exact.");
    expect(sys).toContain("## Output format");
    expect(sys).toContain('"category": one of "tax_notice"');
  });

  it("returns the backend's LlmResult shape", async () => {
    const svc = createService({ config: testConfig(), runtime: new MockRuntime(() => VALID_TRIAGE) });
    const r = await svc.generate({ step: "triage", system: "s", content: [text("x")], schema: TRIAGE_SCHEMA });
    expect(r).toMatchObject({ json: JSON.parse(VALID_TRIAGE), model: "m-fast", servedBy: "mock:m-fast", stopReason: "end_turn", fallbackUsed: false, runtime: "mock", tier: "fast", attempts: 1 });
    expect(r.usage).toMatchObject({ cacheRead: 0, cacheWrite: 0 });
    expect(r.usage.input).toBeGreaterThan(0);
  });

  it("asks once more when the answer does not match the schema, then succeeds", async () => {
    const runtime = new MockRuntime((_req, i) => (i === 0 ? JSON.stringify({ is_candidate: "yes" }) : VALID_TRIAGE));
    const r = await createService({ config: testConfig(), runtime }).generate({ step: "triage", system: "s", content: [text("x")], schema: TRIAGE_SCHEMA });
    expect(r.attempts).toBe(2);
    expect(runtime.calls).toHaveLength(2);
    const retry = runtime.calls[1]!.messages;
    expect(retry.at(-2)!.role).toBe("assistant");
    expect(retry.at(-1)!.content).toMatch(/does not match the required structure/);
  });

  it("gives up with a retryable invalid_json error after the repair attempts", async () => {
    const runtime = new MockRuntime(() => "Sorry, here is a summary instead.");
    const e = await expectError(createService({ config: testConfig({ REPAIR_RETRIES: "1" }), runtime }).generate({ step: "triage", system: "s", content: [text("x")], schema: TRIAGE_SCHEMA }));
    expect(e.kind).toBe("invalid_json");
    expect(e.retryable).toBe(true);
    expect(runtime.calls).toHaveLength(2);
  });

  it("reports a cut-off answer as max_tokens", async () => {
    const runtime = new MockRuntime(() => ({ text: '{"is_candidate": tr', stopReason: "max_tokens" }));
    const e = await expectError(createService({ config: testConfig(), runtime }).generate({ step: "extract", system: "s", content: [text("x")], schema: TRIAGE_SCHEMA }));
    expect(e.kind).toBe("max_tokens");
  });

  it("keeps prompt + answer inside the context window", async () => {
    const svc = createService({ config: testConfig({ NUM_CTX: "4096" }), runtime: new MockRuntime() });
    const e = await expectError(svc.generate({ step: "extract", system: "s", content: [text("word ".repeat(4000))], schema: TRIAGE_SCHEMA }));
    expect(e.kind).toBe("bad_request");
    expect(e.message).toMatch(/NUM_CTX/);

    // a normal request asks for no more answer tokens than fit
    const runtime = new MockRuntime(() => VALID_TRIAGE);
    await createService({ config: testConfig({ NUM_CTX: "4096" }), runtime }).generate({ step: "extract", system: "s", content: [text("short notice")], schema: TRIAGE_SCHEMA, maxTokens: 16000 });
    expect(runtime.calls[0]!.maxTokens).toBeLessThan(4096);
    expect(runtime.calls[0]!.numCtx).toBe(4096);
  });

  it("drops scan attachments for text steps and says so in the prompt", async () => {
    const runtime = new MockRuntime(() => VALID_TRIAGE);
    await createService({ config: testConfig(), runtime }).generate({
      step: "extract",
      system: "s",
      content: [{ type: "pdf", base64: "JVBERi0=" }, text("[[page:1]] transcribed text")],
      schema: TRIAGE_SCHEMA,
    });
    const user = runtime.calls[0]!.messages[1]!;
    expect(user.images).toBeUndefined();
    expect(user.content).toContain("transcribed text");
    expect(user.content).toMatch(/1 scanned original\(s\) were attached/);
  });
});

describe("transcribe (scans and photos)", () => {
  it("renders every PDF page and transcribes them one by one on the vision model", async () => {
    const pdf = readFileSync(new URL("./fixtures/two-page-notice.pdf", import.meta.url)).toString("base64");
    const runtime = new MockRuntime((req) => {
      const n = /page (\d+) of/.exec(req.messages[1]!.content)?.[1];
      return JSON.stringify({ text: `text of page ${n}`, legibility: n === "1" ? 0.95 : 0.8 });
    });
    const r = await createService({ config: testConfig(), runtime }).generate({
      step: "transcribe",
      system: "Transcribe exactly.",
      content: [{ type: "pdf", base64: pdf, title: "scan" }, text('Transcribe "scan.pdf" page by page.')],
      schema: TRANSCRIBE_SCHEMA,
    });
    expect(runtime.calls).toHaveLength(2);
    for (const c of runtime.calls) {
      expect(c.model).toBe("m-vision");
      expect(c.messages[1]!.images).toHaveLength(1);
      expect(c.messages[1]!.images![0]!.mime).toBe("image/png");
      const img = await loadImage(Buffer.from(c.messages[1]!.images![0]!.base64, "base64"));
      expect(Math.max(img.width, img.height)).toBeGreaterThan(1000); // rendered at reading resolution
    }
    expect(r.json).toEqual({ pages: [{ page: 1, text: "text of page 1" }, { page: 2, text: "text of page 2" }], legibility: 0.8 });
    expect(r).toMatchObject({ tier: "vision", model: "m-vision", attempts: 2 });
  });

  it("scales a large photo down and sends it as JPEG", async () => {
    const canvas = createCanvas(3000, 2000);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 3000, 2000);
    ctx.fillStyle = "#000";
    ctx.font = "120px sans-serif";
    ctx.fillText("NOTICE OF DEFICIENCY", 200, 400);
    const photo = (await canvas.encode("png")).toString("base64");
    const runtime = new MockRuntime(() => JSON.stringify({ text: "NOTICE OF DEFICIENCY", legibility: 1 }));
    const r = await createService({ config: testConfig({ VISION_MAX_SIDE: "1000" }), runtime }).generate({
      step: "transcribe",
      system: "s",
      content: [{ type: "image", base64: photo, mediaType: "image/png" }],
      schema: TRANSCRIBE_SCHEMA,
    });
    const sent = runtime.calls[0]!.messages[1]!.images![0]!;
    expect(sent.mime).toBe("image/jpeg");
    const img = await loadImage(Buffer.from(sent.base64, "base64"));
    expect([img.width, img.height]).toEqual([1000, 667]);
    expect(r.json).toEqual({ pages: [{ page: 1, text: "NOTICE OF DEFICIENCY" }], legibility: 1 });
  });

  it("rejects a transcribe request without any image or PDF", async () => {
    const e = await expectError(createService({ config: testConfig(), runtime: new MockRuntime() }).generate({ step: "transcribe", system: "s", content: [text("nothing")], schema: TRANSCRIBE_SCHEMA }));
    expect(e.kind).toBe("bad_request");
  });
});

describe("health", () => {
  it("is ready with the mock runtime", async () => {
    const h = await createService({ config: testConfig(), runtime: new MockRuntime() }).health();
    expect(h).toMatchObject({ ok: true, reachable: true, missing: [] });
  });

  it("names the missing models and how to create them", async () => {
    const runtime: Runtime = {
      name: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      chat: async () => {
        throw new Error("unused");
      },
      listModels: async () => ["legal-notice-reviewer:latest"],
      version: async () => "0.12.0",
    };
    const cfg = testConfig({ MODEL_FAST: "legal-notice-reviewer", MODEL_BALANCED: "legal-notice-reviewer", MODEL_CAPABLE: "legal-notice-reviewer", MODEL_VISION: "legal-notice-reader" });
    const h = await createService({ config: cfg, runtime }).health();
    expect(h.ok).toBe(false);
    expect(h.missing).toEqual(["legal-notice-reader"]);
    expect(h.hint).toContain("ollama create legal-notice-reader -f models/legal-notice-reader.Modelfile");
  });

  it("says how to start the runtime when it is down", async () => {
    const runtime: Runtime = {
      name: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      chat: async () => {
        throw new Error("unused");
      },
      listModels: async () => {
        throw new ServiceError("overloaded", "not reachable", true);
      },
      version: async () => null,
    };
    const h = await createService({ config: testConfig(), runtime }).health();
    expect(h).toMatchObject({ ok: false, reachable: false });
    expect(h.hint).toMatch(/Start Ollama/);
  });
});
