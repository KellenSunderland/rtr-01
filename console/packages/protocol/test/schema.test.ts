import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSchema, renderSchema } from "../src/schema.js";

describe("schema.json", () => {
  it("is up to date (run `pnpm --filter @argus/protocol gen:schema`)", () => {
    const onDisk = readFileSync(fileURLToPath(new URL("../schema.json", import.meta.url)), "utf8");
    expect(onDisk).toBe(renderSchema());
  });
  it("exposes the names openapi.yaml references", () => {
    const s = buildSchema();
    for (const n of ["StreamInfo", "CreateStreamRequest", "CreateSessionRequest", "SessionInfo", "HistoryResult", "ScenarioInfo"]) {
      expect(s).toHaveProperty(n);
    }
  });
});
