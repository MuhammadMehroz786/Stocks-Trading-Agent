import { describe, it, expect } from "@jest/globals";
import { validateOrder, shouldTripCircuitBreaker } from "../src/guardrails/validators.js";
import type { OrderRequest } from "../src/guardrails/validators.js";
import type { GuardrailConfig } from "../src/guardrails/config.js";
import type { DayState } from "../src/guardrails/state.js";

const baseConfig: GuardrailConfig = {
  maxOrderValueUsd: 5000,
  maxOrderPctOfPortfolio: 0.05,
  maxPositionPctOfPortfolio: 0.15,
  dailyLossCircuitBreakerPct: -0.03,
  dailyTradeCountLimit: 30,
  minSharePriceUsd: 5,
  shortSellingEnabled: false,
  tickerAllowlist: [],
  tickerDenylist: ["TQQQ", "SQQQ"],
};

const baseState: DayState = {
  date: "2026-04-27",
  startOfDayValue: 100000,
  currentValue: 100000,
  tradesToday: 0,
  circuitBreakerTripped: false,
};

const baseReq: OrderRequest = {
  ticker: "AAPL",
  shares: 10,
  side: "buy",
  currentPrice: 200,
  portfolioValue: 100000,
  buyingPower: 50000,
  currentSharesOfTicker: 0,
};

describe("validateOrder", () => {
  it("accepts a normal buy", () => {
    expect(validateOrder(baseReq, baseConfig, baseState)).toEqual({ ok: true });
  });

  it("rejects when circuit breaker is tripped", () => {
    const result = validateOrder(baseReq, baseConfig, { ...baseState, circuitBreakerTripped: true });
    expect(result.ok).toBe(false);
  });

  it("rejects when daily trade count is hit", () => {
    const result = validateOrder(baseReq, baseConfig, { ...baseState, tradesToday: 30 });
    expect(result.ok).toBe(false);
  });

  it("rejects denylisted tickers", () => {
    const result = validateOrder({ ...baseReq, ticker: "TQQQ" }, baseConfig, baseState);
    expect(result.ok).toBe(false);
  });

  it("rejects orders not in allowlist when allowlist is set", () => {
    const config = { ...baseConfig, tickerAllowlist: ["MSFT"] };
    const result = validateOrder(baseReq, config, baseState);
    expect(result.ok).toBe(false);
  });

  it("rejects penny stocks", () => {
    const result = validateOrder({ ...baseReq, currentPrice: 2.5 }, baseConfig, baseState);
    expect(result.ok).toBe(false);
  });

  it("rejects orders exceeding max single-order USD", () => {
    // 100 shares * $200 = $20k > $5k limit
    const result = validateOrder({ ...baseReq, shares: 100 }, baseConfig, baseState);
    expect(result.ok).toBe(false);
  });

  it("rejects orders exceeding max single-order % of portfolio", () => {
    // 30 shares * $200 = $6k = 6% of 100k > 5% limit
    const result = validateOrder({ ...baseReq, shares: 30 }, baseConfig, baseState);
    expect(result.ok).toBe(false);
  });

  it("rejects buys that push position over the concentration cap", () => {
    // already hold 70 shares ($14k), buying 10 more = $16k = 16% > 15% limit
    const result = validateOrder({ ...baseReq, currentSharesOfTicker: 70 }, baseConfig, baseState);
    expect(result.ok).toBe(false);
  });

  it("rejects sells beyond holdings", () => {
    const result = validateOrder(
      { ...baseReq, side: "sell", shares: 5, currentSharesOfTicker: 2 },
      baseConfig,
      baseState
    );
    expect(result.ok).toBe(false);
  });

  it("rejects short sells when disabled", () => {
    const result = validateOrder({ ...baseReq, side: "short_sell" }, baseConfig, baseState);
    expect(result.ok).toBe(false);
  });

  it("rejects buys exceeding buying power", () => {
    // 10 shares * $200 = $2k, buying power $1k
    const result = validateOrder({ ...baseReq, buyingPower: 1000 }, baseConfig, baseState);
    expect(result.ok).toBe(false);
  });

  it("rejects cover_short with no short position", () => {
    const result = validateOrder(
      { ...baseReq, side: "cover_short", currentSharesOfTicker: 0 },
      baseConfig,
      baseState
    );
    expect(result.ok).toBe(false);
  });

  it("accepts cover_short within short position size", () => {
    const result = validateOrder(
      { ...baseReq, side: "cover_short", shares: 5, currentSharesOfTicker: -10 },
      baseConfig,
      baseState
    );
    expect(result.ok).toBe(true);
  });

  it("rejects invalid share counts", () => {
    const result = validateOrder({ ...baseReq, shares: NaN }, baseConfig, baseState);
    expect(result.ok).toBe(false);
  });
});

describe("shouldTripCircuitBreaker", () => {
  it("trips when day P&L is below threshold", () => {
    const state: DayState = { ...baseState, currentValue: 96000 }; // -4%
    expect(shouldTripCircuitBreaker(state, baseConfig)).toBe(true);
  });

  it("does not trip when day P&L is above threshold", () => {
    const state: DayState = { ...baseState, currentValue: 98000 }; // -2%
    expect(shouldTripCircuitBreaker(state, baseConfig)).toBe(false);
  });

  it("does not trip when account is up", () => {
    const state: DayState = { ...baseState, currentValue: 105000 };
    expect(shouldTripCircuitBreaker(state, baseConfig)).toBe(false);
  });

  it("returns false on zero start value (defensive)", () => {
    const state: DayState = { ...baseState, startOfDayValue: 0 };
    expect(shouldTripCircuitBreaker(state, baseConfig)).toBe(false);
  });
});
