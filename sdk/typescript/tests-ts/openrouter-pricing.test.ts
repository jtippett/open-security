import { describe, expect, test } from "bun:test";
import { estimateScanCost } from "../src/cost.js";
import { OPENROUTER_MODEL_PRICING_NANODOLLARS } from "../src/openrouter-pricing.js";

// open-models fork: generated OpenRouter pricing feeds cost estimates.
describe("OpenRouter pricing catalog", () => {
  const usage = {
    input_tokens: 1_000_000,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 1_000_000,
    reasoning_output_tokens: 0,
    total_tokens: 2_000_000,
  };

  test("has well-formed rows for the default open models", () => {
    for (const model of ["z-ai/glm-5.3", "deepseek/deepseek-v4-pro"]) {
      const rates = OPENROUTER_MODEL_PRICING_NANODOLLARS[model];
      expect(rates).toBeDefined();
      expect(rates).toHaveLength(4);
      for (const rate of rates!) {
        expect(Number.isSafeInteger(rate)).toBe(true);
        expect(rate).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("estimates cost for OpenRouter model ids", () => {
    const [input, , , output] =
      OPENROUTER_MODEL_PRICING_NANODOLLARS["z-ai/glm-5.3"]!;
    const cost = estimateScanCost("z-ai/glm-5.3", usage);
    expect(cost).not.toBeNull();
    expect(cost!.estimatedUsd).toBeCloseTo((input + output) / 1_000, 6);
  });

  test("keeps upstream pricing authoritative and unknown models unpriced", () => {
    expect(estimateScanCost("gpt-5.6-sol", usage)?.estimatedUsd).toBe(35);
    expect(estimateScanCost("nobody/no-such-model", usage)).toBeNull();
  });
});
