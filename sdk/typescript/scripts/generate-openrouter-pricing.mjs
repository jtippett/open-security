// open-models fork: regenerate src/openrouter-pricing.ts from OpenRouter's
// public model catalog. Run `pnpm generate:pricing`. Rates are nanodollars per
// token: [input, cachedInput, cacheWriteInput, output], matching cost.ts.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(packageRoot, "src", "openrouter-pricing.ts");
const endpoint = "https://openrouter.ai/api/v1/models";

function nanodollarsPerToken(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0) return null;
  return Math.round(rate * 1e9);
}

const response = await fetch(endpoint);
if (!response.ok) {
  throw new Error(
    `OpenRouter model catalog request failed: ${response.status}`,
  );
}
const { data } = await response.json();
if (!Array.isArray(data))
  throw new Error("Unexpected OpenRouter catalog shape.");

const rows = [];
for (const model of data) {
  if (typeof model?.id !== "string" || !model.pricing) continue;
  const input = nanodollarsPerToken(model.pricing.prompt);
  const outputRate = nanodollarsPerToken(model.pricing.completion);
  if (input === null || outputRate === null) continue;
  const cachedInput =
    nanodollarsPerToken(model.pricing.input_cache_read) ?? input;
  const cacheWriteInput =
    nanodollarsPerToken(model.pricing.input_cache_write) ?? input;
  rows.push([model.id, [input, cachedInput, cacheWriteInput, outputRate]]);
}
rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const generatedAt = new Date().toISOString().slice(0, 10);
const body = rows
  .map(([id, rates]) => `  ${JSON.stringify(id)}: [${rates.join(", ")}],`)
  .join("\n");
const source = `/* Generated from ${endpoint} on ${generatedAt}. Run \`pnpm generate:pricing\`. */
/* open-models fork: OpenRouter list prices in nanodollars per token
   [input, cachedInput, cacheWriteInput, output]; see cost.ts. */

export type OpenRouterModelPricing = readonly [
  input: number,
  cachedInput: number,
  cacheWriteInput: number,
  output: number,
];

export const OPENROUTER_MODEL_PRICING_NANODOLLARS: Readonly<
  Record<string, OpenRouterModelPricing>
> = {
${body}
};
`;
writeFileSync(output, await format(source, { parser: "typescript" }));
console.log(`Wrote ${rows.length} OpenRouter pricing rows to ${output}`);
