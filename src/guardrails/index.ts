export { loadGuardrailConfig, GuardrailConfigSchema } from "./config.js";
export type { GuardrailConfig } from "./config.js";
export {
  recomputeIfNewDay,
  incrementTradeCount,
  markCircuitBreakerTripped,
  getCurrentState,
} from "./state.js";
export type { DayState } from "./state.js";
export { validateOrder, shouldTripCircuitBreaker } from "./validators.js";
export type { OrderRequest, ValidationResult, Side } from "./validators.js";

export const KILL_SWITCH_FILES = ["KILL", "kill.flag"];

import { existsSync } from "fs";

export function isKillSwitchActive(): boolean {
  return KILL_SWITCH_FILES.some((f) => existsSync(f));
}
