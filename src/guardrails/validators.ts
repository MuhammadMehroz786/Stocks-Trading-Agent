import type { GuardrailConfig } from "./config.js";
import type { DayState } from "./state.js";

export type Side = "buy" | "sell" | "short_sell" | "cover_short";

export type OrderRequest = {
  ticker: string;
  shares: number;
  side: Side;
  currentPrice: number;
  portfolioValue: number;
  buyingPower: number;
  currentSharesOfTicker: number;
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export function validateOrder(
  req: OrderRequest,
  config: GuardrailConfig,
  state: DayState
): ValidationResult {
  const t = req.ticker.toUpperCase();
  const orderValue = req.shares * req.currentPrice;

  if (state.circuitBreakerTripped) {
    return { ok: false, reason: "Daily loss circuit breaker is tripped. No more trades today." };
  }

  if (state.tradesToday >= config.dailyTradeCountLimit) {
    return { ok: false, reason: `Daily trade count limit (${config.dailyTradeCountLimit}) reached.` };
  }

  if (req.side === "short_sell" && !config.shortSellingEnabled) {
    return { ok: false, reason: "Short selling is disabled in guardrail config." };
  }

  if (config.tickerAllowlist.length > 0 && !config.tickerAllowlist.includes(t)) {
    return { ok: false, reason: `Ticker ${t} is not in the allowlist.` };
  }

  if (config.tickerDenylist.includes(t)) {
    return { ok: false, reason: `Ticker ${t} is on the denylist (leveraged/risky instrument).` };
  }

  if (req.currentPrice < config.minSharePriceUsd && (req.side === "buy" || req.side === "short_sell")) {
    return {
      ok: false,
      reason: `Share price $${req.currentPrice.toFixed(2)} is below minimum $${config.minSharePriceUsd} (penny stock filter).`,
    };
  }

  if (req.shares <= 0 || !Number.isFinite(req.shares)) {
    return { ok: false, reason: `Invalid share count: ${req.shares}` };
  }

  if (req.side === "buy" || req.side === "short_sell") {
    if (orderValue > config.maxOrderValueUsd) {
      return {
        ok: false,
        reason: `Order value $${orderValue.toFixed(2)} exceeds max single-order limit $${config.maxOrderValueUsd}.`,
      };
    }

    if (req.portfolioValue > 0) {
      const orderPct = orderValue / req.portfolioValue;
      if (orderPct > config.maxOrderPctOfPortfolio) {
        return {
          ok: false,
          reason: `Order is ${(orderPct * 100).toFixed(1)}% of portfolio; max is ${(config.maxOrderPctOfPortfolio * 100).toFixed(1)}%.`,
        };
      }

      if (req.side === "buy") {
        const newPositionValue = (req.currentSharesOfTicker + req.shares) * req.currentPrice;
        const newPositionPct = newPositionValue / req.portfolioValue;
        if (newPositionPct > config.maxPositionPctOfPortfolio) {
          return {
            ok: false,
            reason: `Position in ${t} would be ${(newPositionPct * 100).toFixed(1)}% of portfolio; max is ${(config.maxPositionPctOfPortfolio * 100).toFixed(1)}%.`,
          };
        }
      }
    }

    if (req.side === "buy" && orderValue > req.buyingPower) {
      return {
        ok: false,
        reason: `Order value $${orderValue.toFixed(2)} exceeds buying power $${req.buyingPower.toFixed(2)}.`,
      };
    }
  }

  if (req.side === "sell") {
    if (req.shares > req.currentSharesOfTicker) {
      return {
        ok: false,
        reason: `Cannot sell ${req.shares} shares of ${t}; only hold ${req.currentSharesOfTicker}.`,
      };
    }
  }

  if (req.side === "cover_short") {
    if (req.currentSharesOfTicker >= 0) {
      return { ok: false, reason: `No short position in ${t} to cover.` };
    }
    if (req.shares > Math.abs(req.currentSharesOfTicker)) {
      return {
        ok: false,
        reason: `Cannot cover ${req.shares}; short position is ${Math.abs(req.currentSharesOfTicker)} shares.`,
      };
    }
  }

  return { ok: true };
}

export function shouldTripCircuitBreaker(
  state: DayState,
  config: GuardrailConfig
): boolean {
  if (state.startOfDayValue <= 0) return false;
  const dayPnlPct = (state.currentValue - state.startOfDayValue) / state.startOfDayValue;
  return dayPnlPct <= config.dailyLossCircuitBreakerPct;
}
