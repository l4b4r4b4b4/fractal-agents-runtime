#!/usr/bin/env bun
/**
 * Generate OpenAPI spec JSON from the TypeScript runtime's spec definition.
 *
 * Usage:
 *   bun run scripts/generate-openapi.ts                    # writes to openapi-spec.json
 *   bun run scripts/generate-openapi.ts -o docs/api.json   # custom output path
 *   bun run scripts/generate-openapi.ts --validate         # validate only, no write
 */

import { OPENAPI_SPEC } from "../src/openapi";
import { parseArgs } from "util";
import { resolve, dirname } from "path";
import { mkdirSync, writeFileSync, readFileSync, statSync } from "fs";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    output: { type: "string", short: "o", default: "openapi-spec.json" },
    validate: { type: "boolean", default: false },
    compact: { type: "boolean", default: false },
  },
});

const specJson = values.compact
  ? JSON.stringify(OPENAPI_SPEC)
  : JSON.stringify(OPENAPI_SPEC, null, 2);

const pathCount = Object.keys(OPENAPI_SPEC.paths).length;
const operationCount = Object.values(OPENAPI_SPEC.paths).reduce(
  (sum: number, methods: unknown) =>
    sum + Object.keys(methods as Record<string, unknown>).length,
  0,
);

if (values.validate) {
  // Check if the existing file matches what we'd generate
  const outputPath = resolve(values.output!);
  try {
    const existing = readFileSync(outputPath, "utf-8");
    const expectedContent = specJson + "\n";
    if (existing === expectedContent) {
      console.log(
        `Valid OpenAPI ${OPENAPI_SPEC.openapi} spec: ${pathCount} paths, ${operationCount} operations (file is current)`,
      );
      process.exit(0);
    } else {
      console.error(
        `OpenAPI spec is STALE — ${outputPath} does not match generated spec. Run without --validate to update.`,
      );
      process.exit(1);
    }
  } catch {
    console.error(
      `OpenAPI spec file not found at ${outputPath}. Run without --validate to generate.`,
    );
    process.exit(1);
  }
}

// Write the spec
const outputPath = resolve(values.output!);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, specJson + "\n", "utf-8");

const sizeBytes = statSync(outputPath).size;
console.log(
  `Wrote ${values.output} (${sizeBytes.toLocaleString()} bytes, ${pathCount} paths, ${operationCount} operations)`,
);
