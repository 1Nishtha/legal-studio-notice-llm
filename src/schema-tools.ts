/**
 * JSON-schema helpers:
 *  - schemaOutline: a compact, readable outline written into the prompt. Runtimes constrain the
 *    output with the schema, but a small model never sees field descriptions unless we show them.
 *  - validatorFor: Ajv validation of every answer (catches truncated or off-schema output).
 *  - exampleFromSchema: a minimal valid instance (used by the mock runtime).
 */
import { Ajv, type ValidateFunction } from "ajv";

export type JsonSchema = Record<string, unknown>;

// ------------------------------------------------------------------ outline
export function schemaOutline(schema: JsonSchema): string {
  const seen = new Set<string>(); // "key::description" pairs already printed
  return render(schema, 0, seen);
}

function render(s: JsonSchema, depth: number, seen: Set<string>): string {
  if (Array.isArray(s.enum)) return `one of ${s.enum.map((v) => JSON.stringify(v)).join(" | ")}`;
  if ("const" in s) return JSON.stringify(s.const);
  const alts = (s.anyOf ?? s.oneOf) as JsonSchema[] | undefined;
  if (Array.isArray(alts)) return alts.map((a) => render(a, depth, seen)).join(" or ");
  if (Array.isArray(s.type)) return (s.type as string[]).map((t) => render({ ...s, type: t }, depth, seen)).join(" or ");

  if (s.type === "object" || s.properties) {
    const props = (s.properties ?? {}) as Record<string, JsonSchema>;
    const keys = Object.keys(props);
    if (!keys.length) return "object";
    const required = new Set((s.required as string[] | undefined) ?? []);
    const pad = "  ".repeat(depth + 1);
    const lines = keys.map((k) => {
      const p = props[k] ?? {};
      const optional = required.has(k) ? "" : " (optional)";
      let comment = "";
      if (typeof p.description === "string" && p.description.trim()) {
        const tag = `${k}::${p.description}`;
        if (!seen.has(tag)) {
          seen.add(tag);
          comment = `  // ${p.description.replace(/\s+/g, " ").trim()}`;
        }
      }
      return `${pad}"${k}": ${render(p, depth + 1, seen)}${optional}${comment}`;
    });
    return `{\n${lines.join(",\n")}\n${"  ".repeat(depth)}}`;
  }
  if (s.type === "array") {
    const items = (s.items ?? {}) as JsonSchema;
    return `list of ${render(items, depth, seen)}`;
  }
  switch (s.type) {
    case "string":
      return typeof s.maxLength === "number" ? `string (max ${s.maxLength} chars)` : "string";
    case "integer":
      return "integer";
    case "number":
      return "number";
    case "boolean":
      return "true or false";
    case "null":
      return "null";
    default:
      return "any JSON value";
  }
}

// ------------------------------------------------------------------ validation
const ajv = new Ajv({ allErrors: true, strict: false, validateSchema: false });
const cache = new Map<string, ValidateFunction>();

export function validatorFor(schema: JsonSchema): ValidateFunction {
  const key = JSON.stringify(schema);
  let v = cache.get(key);
  if (!v) {
    v = ajv.compile(schema);
    cache.set(key, v);
    if (cache.size > 64) cache.delete(cache.keys().next().value as string);
  }
  return v;
}

export function describeErrors(v: ValidateFunction): string {
  return (v.errors ?? [])
    .slice(0, 8)
    .map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`)
    .join("; ");
}

// ------------------------------------------------------------------ minimal instance
export function exampleFromSchema(s: JsonSchema): unknown {
  if (Array.isArray(s.enum)) return s.enum[0];
  if ("const" in s) return s.const;
  const alts = (s.anyOf ?? s.oneOf) as JsonSchema[] | undefined;
  if (Array.isArray(alts) && alts.length) return exampleFromSchema(alts.find((a) => a.type === "null") ?? alts[0]!);
  const type = Array.isArray(s.type) ? ((s.type as string[]).includes("null") ? "null" : (s.type as string[])[0]) : s.type;
  switch (type) {
    case "object": {
      const props = (s.properties ?? {}) as Record<string, JsonSchema>;
      const keys = (s.required as string[] | undefined) ?? Object.keys(props);
      return Object.fromEntries(keys.filter((k) => props[k]).map((k) => [k, exampleFromSchema(props[k]!)]));
    }
    case "array": {
      const min = typeof s.minItems === "number" ? s.minItems : 0;
      return Array.from({ length: min }, () => exampleFromSchema((s.items ?? {}) as JsonSchema));
    }
    case "string":
      return "";
    case "number":
    case "integer":
      return typeof s.minimum === "number" ? s.minimum : 0;
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return s.properties ? exampleFromSchema({ ...s, type: "object" }) : null;
  }
}
