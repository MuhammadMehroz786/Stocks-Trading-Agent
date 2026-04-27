import { existsSync, readFileSync } from "fs";
import { z } from "zod";

export const GuardrailConfigSchema = z.object({
  maxOrderValueUsd: z.number().positive(),
  maxOrderPctOfPortfolio: z.number().min(0).max(1),
  maxPositionPctOfPortfolio: z.number().min(0).max(1),
  dailyLossCircuitBreakerPct: z.number().lte(0),
  dailyTradeCountLimit: z.number().int().positive(),
  minSharePriceUsd: z.number().nonnegative(),
  shortSellingEnabled: z.boolean(),
  tickerAllowlist: z.array(z.string()),
  tickerDenylist: z.array(z.string()),
});

export type GuardrailConfig = z.infer<typeof GuardrailConfigSchema>;

const SAFE_DEFAULTS: GuardrailConfig = {
  maxOrderValueUsd: 5000,
  maxOrderPctOfPortfolio: 0.05,
  maxPositionPctOfPortfolio: 0.15,
  dailyLossCircuitBreakerPct: -0.03,
  dailyTradeCountLimit: 30,
  minSharePriceUsd: 5,
  shortSellingEnabled: false,
  tickerAllowlist: [],
  tickerDenylist: [
    "TQQQ", "SQQQ", "UVXY", "SVXY", "VXX", "UVIX", "SVIX",
    "SPXL", "SPXS", "TNA", "TZA", "FAS", "FAZ", "TMF", "TMV",
    "SOXL", "SOXS", "LABU", "LABD", "NAIL", "DRN", "DRV",
  ],
};

export function loadGuardrailConfig(path = "config/guardrails.json"): GuardrailConfig {
  if (!existsSync(path)) {
    console.warn(`[guardrails] ${path} not found — using SAFE DEFAULTS`);
    return SAFE_DEFAULTS;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return GuardrailConfigSchema.parse(raw);
  } catch (err) {
    console.warn(`[guardrails] failed to parse ${path}: ${err} — using SAFE DEFAULTS`);
    return SAFE_DEFAULTS;
  }
}
