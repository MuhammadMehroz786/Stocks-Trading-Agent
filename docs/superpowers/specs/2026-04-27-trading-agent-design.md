# Autonomous LLM Stock Trading Agent — Design

Date: 2026-04-27

## Goal

A fully autonomous AI agent that trades US stocks on Alpaca paper trading, using an LLM (GPT-5-mini by default) for all decisions. Built on top of `matthewchung74/llm_trader` as a base, with a hardened safety/guardrail layer added on top because the base is too trusting of LLM output for fully autonomous use.

## Non-goals

- Live trading with real money. Paper only.
- Multi-broker support (Alpaca only for v1).
- Crypto, forex, options.
- A multi-agent debate framework (single agent first; we can add a "second opinion" agent later).
- Backtesting against historical data (tracked as future work, not v1).

## Why this base

`llm_trader` already provides: Alpaca paper trading wired up, an LLM agent loop with tool calls (think, get_portfolio, get_net_worth, get_stock_price, buy, sell, short_sell, cover_short, web_search), thread persistence, market-hours awareness, P&L CSV reports, and a Docker setup. It's TypeScript, ~2400 lines in the main agent file, and lean enough to fork and modify.

The biggest weakness of the base is that its only safety layer is the system prompt — and that's not enough for a fully autonomous LLM. An LLM can hallucinate a ticker, panic-sell during volatility, or place a single trade that uses 100% of buying power on one stock. We will add hard limits in the tool layer that the LLM cannot override.

## Architecture

```
Orchestrator (agent.ts main loop)
  └─ Market-hours gate
  └─ Kill-switch check (reads KILL file, exits if present)
  └─ LLM agent run
       ├─ think tool        (unchanged)
       ├─ get_portfolio     (unchanged)
       ├─ get_net_worth     (unchanged)
       ├─ get_stock_price   (unchanged)
       ├─ web_search        (unchanged)
       ├─ buy   ───┐
       ├─ sell  ───┼──► [GUARDRAIL LAYER]  ──► Alpaca API
       ├─ short_sell ─┤
       └─ cover_short ┘
```

Every order-placing tool is wrapped by the guardrail layer. The LLM cannot bypass it because the LLM only sees the wrapped tool, not the raw Alpaca client.

## Components

### 1. Guardrail layer (`src/guardrails/`)

A pure-function validator that takes a proposed order and either returns `ok` or `reject(reason)`. Order placement only proceeds on `ok`. Configuration lives in `config/guardrails.json` (created with sensible defaults).

Hard limits enforced (all configurable):

| Limit | Default | Why |
|---|---|---|
| Max single-order value (USD) | $5,000 | Prevents one bad trade blowing up the account |
| Max single-order % of portfolio | 5% | Same idea, scales with account size |
| Max position % of portfolio | 15% | Caps concentration in one ticker |
| Daily loss circuit breaker | -3% from start of day | Stops the bleeding before it gets worse |
| Daily trade count limit | 30 | Prevents an LLM stuck in a loop from racking up commissions |
| Ticker allowlist | optional, off by default | When set, only listed tickers can be traded |
| Ticker denylist | leveraged ETFs (TQQQ, SQQQ, UVXY, etc.) and penny stocks (price < $5) | These have outsized risk for an LLM that doesn't understand them |
| Short selling | disabled by default | Unlimited downside; off until explicitly enabled |
| Order type | market only | Block any attempt at exotic order types |

The guardrail file is reloaded at the start of each session, so changes don't require a restart.

### 2. Kill switch

A simple file-based switch: if `KILL` (or `kill.flag`) exists in the project root, the agent exits cleanly without making any LLM calls or trades. This is the "panic button" the user can hit if they want to stop everything fast — `touch KILL`.

### 3. State / circuit-breaker store (`data/state.json`)

Tracks per-day:
- Starting portfolio value
- Current portfolio value
- Trades placed today
- Whether circuit breaker has tripped (once tripped, stays tripped for the rest of the day)

Reset on date change (US/Eastern).

### 4. Customized system prompt

Replace the base prompt with one that:
- States the universe (US large-cap stocks, no leveraged ETFs, no penny stocks)
- Explains the hard limits exist and reasoning will be rejected if it tries to evade them
- Asks for explicit reasoning before each trade (the `think` tool, already enforced)
- Adds a "default action is hold" clause — the agent should not feel compelled to trade every cycle

### 5. Local status dashboard (`src/dashboard-server.ts`)

A tiny Express server (port 3737) showing:
- Current portfolio value, day's P&L, all-time P&L
- Active positions
- Today's trades + the LLM's reasoning per trade
- Circuit breaker status, kill switch status
- Last 50 log lines

Read-only. No trading buttons (deliberately — anything that places trades goes through the agent loop).

### 6. Wake-up README

A clear top-level `WAKE_UP.md` (and rewritten `README.md`) with:
- "Sign up for Alpaca paper" (link, what to copy)
- "Sign up for OpenAI" (link, where to find key, how much to add)
- Where to paste the keys (`.env`)
- The single command to run (`npm install && npm start` for one cycle, `npm run start:continuous` for loop)
- How to hit the kill switch
- Where to view the dashboard

## Data flow (a single trading cycle)

1. Orchestrator wakes up (cron-style, every 30 min during market hours).
2. Check kill switch → if present, exit.
3. Check market open → if closed, sleep until next open.
4. Load state.json, recompute today's start-of-day if date changed.
5. Check circuit breaker → if tripped, log and skip the cycle.
6. Run the LLM agent. It reads portfolio, looks up prices, optionally web-searches, decides on a trade (or no trade).
7. If LLM calls buy/sell/short_sell/cover_short, the wrapped tool runs the guardrail layer first.
   - On reject: returns the reason to the LLM as the tool result. LLM can choose a smaller order or hold.
   - On accept: places the order via Alpaca.
8. After the run, update state.json, write logs and CSV row.
9. Update dashboard data file. Return to step 1 after the interval.

## Error handling

Inherited from the base where it's already good (thread corruption recovery, retry on Alpaca/OpenAI flakes). New failure modes from this design:

- **Guardrail config malformed:** fall back to safest defaults, log a loud warning. Do not silently trade with no limits.
- **state.json corrupted:** rebuild from Alpaca account history.
- **Dashboard server crashes:** does not affect the trading agent; agent keeps running.

## Testing

Existing Jest tests run; we add:
- Unit tests for each guardrail rule (single-order cap, position cap, allowlist, denylist, circuit breaker, daily count).
- Integration test: feed a synthetic LLM trace that tries to violate each rule, assert each gets rejected.
- Smoke test: agent runs against the Alpaca paper API with a fake LLM that returns "hold every cycle". Verifies the wiring.

## What's deliberately out of scope for v1

- LLM model swap to Claude (single env-var change later; not now).
- Backtesting harness.
- Multi-strategy portfolio (one agent, one strategy).
- Web UI for editing guardrails (edit `config/guardrails.json` by hand).
- Notifications (email/SMS on circuit breaker trip). The dashboard surfaces it.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| LLM hallucinates a ticker that doesn't exist | Alpaca rejects unknown tickers. Logged and returned to LLM. |
| LLM panic-sells during a normal dip | Daily loss circuit breaker stops trading at -3%. |
| LLM stuck in a buy/sell loop | Daily trade count cap (30). |
| User accidentally enables live trading | `ALPACA_BASE_URL` is hard-checked at startup and refuses to run if it's not the paper URL. v1 won't run against live. |
| OpenAI API costs run away | Logged per-cycle; default cadence is 30 min during market hours; GPT-5-mini is cheap. |
| Free Alpaca data is delayed (15 min) | Acceptable for swing/position trading at 30-min cadence. |
