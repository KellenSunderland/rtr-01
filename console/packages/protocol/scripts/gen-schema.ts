import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderSchema } from "../src/schema.js";

writeFileSync(fileURLToPath(new URL("../schema.json", import.meta.url)), renderSchema());
console.log("wrote schema.json");
