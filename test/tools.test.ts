import { describe, expect, it } from "vitest";
import { ServiceError } from "../src/errors.js";
import { parseModelJson } from "../src/json.js";
import { exampleFromSchema, schemaOutline, validatorFor } from "../src/schema-tools.js";
import { TRANSCRIBE_SCHEMA, TRIAGE_SCHEMA } from "./helpers.js";

describe("schemaOutline", () => {
  it("renders enums, nullable unions, lists and nesting readably", () => {
    const out = schemaOutline(TRIAGE_SCHEMA);
    expect(out).toContain('"category": one of "tax_notice" | "regulatory_notice" | "other"');
    expect(out).toContain('"agency_guess": string or null');
    expect(out).toContain('"reasons": list of string');
    expect(out).toContain('"is_candidate": true or false');
  });

  it("prints a repeated field description only once", () => {
    const field = (d: string) => ({
      type: "object",
      required: ["quote", "value"],
      properties: { quote: { type: "string", description: "Verbatim quote from the page" }, value: { type: "string", description: d } },
    });
    const out = schemaOutline({ type: "object", required: ["a", "b"], properties: { a: field("Agency name"), b: field("Notice code") } });
    expect(out.match(/Verbatim quote from the page/g)).toHaveLength(1);
    expect(out).toContain("Agency name");
    expect(out).toContain("Notice code");
  });

  it("marks optional properties", () => {
    expect(schemaOutline({ type: "object", required: [], properties: { note: { type: "string" } } })).toContain('"note": string (optional)');
  });
});

describe("exampleFromSchema", () => {
  it("produces instances that pass validation", () => {
    for (const schema of [TRIAGE_SCHEMA, TRANSCRIBE_SCHEMA, { type: "object", required: ["n"], properties: { n: { type: "integer", minimum: 1 } } }]) {
      const v = validatorFor(schema);
      expect(v(exampleFromSchema(schema)), JSON.stringify(v.errors)).toBe(true);
    }
  });
});

describe("parseModelJson", () => {
  it("accepts clean JSON, code fences, surrounding prose and trailing commas", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('Here you go: {"a": [1, 2,],} Thanks!')).toEqual({ a: [1, 2] });
  });

  it("throws a retryable invalid_json error for garbage", () => {
    try {
      parseModelJson("I cannot help with that.");
      throw new Error("expected a failure");
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceError);
      expect((e as ServiceError).kind).toBe("invalid_json");
      expect((e as ServiceError).retryable).toBe(true);
    }
  });
});
