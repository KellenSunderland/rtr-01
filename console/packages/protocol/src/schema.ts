import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import * as P from "./index.js";

/** JSON Schema for every exported zod schema, keyed by export name. */
export function buildSchema(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(P).sort(([a], [b]) => a.localeCompare(b))) {
    const v = value as { safeParse?: unknown; _def?: unknown };
    if (v && typeof v === "object" && typeof v.safeParse === "function" && v._def) {
      out[name] = zodToJsonSchema(value as ZodTypeAny, { $refStrategy: "none", target: "jsonSchema7" });
    }
  }
  return out;
}

export function renderSchema(): string {
  return JSON.stringify(buildSchema(), null, 2) + "\n";
}
