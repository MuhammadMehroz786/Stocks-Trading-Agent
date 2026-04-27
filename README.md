# Stocks Trading Agent

> An autonomous LLM-powered stock trading agent — with the safety rails the LLM cannot override.

[![Paper Trading](https://img.shields.io/badge/mode-paper%20only-success)](#safety)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript-blue)](#)
[![Tests](https://img.shields.io/badge/guardrail%20tests-19%2F19%20passing-success)](#tests)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

A GPT-5 powered agent that reads the market, reasons about positions, and places trades on its own — bounded by a code-enforced risk layer that an LLM cannot talk its way around. Built for people who want to *actually* run an autonomous trader, not just demo one.

---

## Why this exists

Most "AI trading bot" repos on GitHub do one of two things:

1. Hand the LLM a buy/sell tool and a system prompt, then *hope*. One bad prompt response and the account is gone.
2. Ship as a research framework that's impossible to actually deploy.

This repo does neither. It takes a clean, working LLM-trader base ([matthewchung74/llm_trader](https://github.com/matthewchung74/llm_trader)) and wraps every order with a **deterministic, code-enforced guardrail layer**. The LLM doesn't get to choose whether to obey the rules — the rules are checked *after* the LLM decides, *before* the order hits the broker. If the LLM tries to drop $50k on a single penny stock, the order is rejected and the LLM is told why.

You wake up in the morning. The agent has been awake the whole night. Your account is still there.

---

## What it does

- 🤖 **Autonomous trading** — GPT-5-mini (or any OpenAI model) decides what to trade, when, and how much.
- 🛡️ **Guardrail layer** — single-order limits, position caps, daily loss circuit breaker, trade-count cap, ticker allow/denylist, penny-stock filter, short-sell toggle. All enforced in code.
- 📄 **Paper trading by default** — Alpaca paper account. The startup check refuses to point at the live trading URL.
- 🛑 **Kill switch** — `touch KILL` and the agent stops on the next tick.
- 📊 **Local dashboard** — portfolio, positions, recent orders, guardrail config, log tail. Auto-refresh.
- 🧠 **Persistent memory** — thread state survives restarts; agent remembers its theses across cycles.
- ⏰ **Market-hours aware** — sleeps overnight and weekends, wakes up at 9:30 AM ET.
- 🇬🇧 **UK-friendly path** — Alpaca paper for development; clean broker abstraction so swapping in Trading 212 (UK ISA) is a small change.

---

## How it works

```
┌──────────────────────────────────────────────────────────────────┐
│                      Orchestrator (every 30 min)                 │
│   ┌────────────┐  ┌─────────────┐  ┌────────────────────────┐    │
│   │  KILL file │→ │ Market open │→ │ Circuit breaker check  │    │
│   └────────────┘  └─────────────┘  └────────────────────────┘    │
│           ↓                                                      │
│   ┌──────────────────────── LLM Agent ──────────────────────┐    │
│   │  think → get_portfolio → get_price → web_search → buy   │    │
│   └─────────────────────────────────────────────────────────┘    │
│                              ↓                                   │
│            ┌──────── GUARDRAIL LAYER ────────┐                   │
│            │  • max single order $/% size    │                   │
│            │  • max position concentration   │                   │
│            │  • daily loss limit             │                   │
│            │  • daily trade count            │                   │
│            │  • ticker allow/denylist        │                   │
│            │  • penny stock filter           │                   │
│            └──────────────┬──────────────────┘                   │
│                           ↓                                      │
│                  ┌────────────────┐                              │
│                  │  Alpaca paper  │                              │
│                  └────────────────┘                              │
└──────────────────────────────────────────────────────────────────┘
```

Every order-placing tool the LLM has access to (`buy`, `sell`, `short_sell`, `cover_short`) is wrapped. The LLM never touches the Alpaca client directly. Rejections come back as natural-language tool results — the LLM reads them and adjusts.

---

## Quickstart

```bash
git clone https://github.com/MuhammadMehroz786/Stocks-Trading-Agent.git
cd Stocks-Trading-Agent
npm install
cp .env.example .env       # paste your Alpaca paper + OpenAI keys
npm start                  # run a single trading cycle
```

For the full sign-up walkthrough (Alpaca + OpenAI), see **[`WAKE_UP.md`](./WAKE_UP.md)**.

```bash
npm run start:continuous   # 30-min cadence during market hours
npm run dashboard:web      # local dashboard at http://localhost:3737
npm test -- guardrails     # run the guardrail unit tests (19/19 pass)
touch KILL                 # panic button — agent exits cleanly
```

---

## Default risk limits

Edit [`config/guardrails.json`](./config/guardrails.json). Reloaded on each cycle — no restart needed.

| Limit | Default | Purpose |
| --- | --- | --- |
| Max single-order USD | **$5,000** | Caps damage from any one bad decision |
| Max single-order % of portfolio | **5%** | Scales the cap with account size |
| Max position % of portfolio | **15%** | Stops concentration in one ticker |
| Daily loss circuit breaker | **−3%** | Halts trading after a bad day |
| Daily trade count | **30** | Stops a stuck-in-a-loop LLM |
| Min share price | **$5** | No penny stocks |
| Short selling | **off** | Unlimited downside; opt-in only |
| Ticker denylist | **TQQQ, SQQQ, UVXY, …** | No leveraged/inverse ETFs |
| Ticker allowlist | *empty (all stocks ok)* | Set this to constrain the universe |

---

## Project layout

```
.
├── src/
│   ├── agent.ts                 ← main agent loop (LLM + tools)
│   ├── dashboard-server.ts      ← local web dashboard (port 3737)
│   ├── guardrails/
│   │   ├── config.ts            ← loads & validates config/guardrails.json
│   │   ├── validators.ts        ← pure-function order validation
│   │   ├── state.ts             ← daily P&L + trade count + circuit breaker
│   │   └── index.ts             ← public exports + kill switch
│   └── trading.ts               ← Alpaca wrapper (broker layer)
├── config/
│   └── guardrails.json          ← edit me to tune risk
├── tests/
│   └── guardrails.test.ts       ← 19 unit tests covering every rule
├── docs/superpowers/
│   ├── specs/…design.md         ← design doc
│   └── plans/…plan.md           ← implementation plan
├── system-prompt.md             ← what the LLM is told
├── WAKE_UP.md                   ← end-to-end setup guide
└── README.md                    ← you are here
```

---

## Safety

This repo is built around the assumption that **an autonomous LLM will eventually do something stupid** if you let it. The defenses, in order:

1. **Paper-only check.** `ALPACA_BASE_URL` is verified at startup. If it doesn't include `paper-api`, the process exits before the LLM even loads.
2. **Guardrail layer.** Every order is validated *after* the LLM decides and *before* the broker is called. The LLM cannot bypass this — the wrapped tools are the only ones it has.
3. **Kill switch.** A single file (`KILL` in the project root) makes the agent exit on the next tick. Run `touch KILL` from any terminal.
4. **Daily loss circuit breaker.** Persisted in `data/state.json`. Once tripped, no further trades that day, regardless of what the LLM thinks.
5. **Daily trade count cap.** Stops a malfunctioning LLM from placing 1,000 orders in an hour.
6. **Conservative defaults.** No leveraged ETFs, no penny stocks, no short selling, max 5% per order.

If you eventually flip to live trading, do it with eyes wide open: rip out the `ALPACA_BASE_URL` check intentionally, lower limits further, and consider running on a small fixed amount of capital you're prepared to lose.

---

## Tests

```bash
npm test -- guardrails
```

19 unit tests covering each rule individually plus the circuit-breaker math. They run in ~3 seconds and are designed to catch regressions when you tweak the config or the validator logic.

---

## Roadmap

- [ ] **Trading 212 broker adapter** (UK ISA support, real money path)
- [ ] **Claude as the LLM** (better reasoning per dollar)
- [ ] **Backtesting harness** (run the agent against historical bars before going live)
- [ ] **Multi-agent debate** (bull, bear, trader, risk manager — pattern from [TradingAgents](https://github.com/TauricResearch/TradingAgents))
- [ ] **Slack/email notifications** on circuit breaker trip and large drawdowns
- [ ] **Strategy evaluator** to cross-check the LLM's thesis against quant signals

---

## Credits

Built on top of [`matthewchung74/llm_trader`](https://github.com/matthewchung74/llm_trader). The agent loop, Alpaca wiring, and OpenAI tool plumbing come from there. The guardrail layer, kill switch, dashboard, paper-only check, system prompt, and tests are added on top.

Inspired by [`TauricResearch/TradingAgents`](https://github.com/TauricResearch/TradingAgents) — their multi-agent debate pattern is on the roadmap.

---

## License

MIT. Inherited from upstream. See [LICENSE](LICENSE).

---

> **Disclaimer:** This is not investment advice. Paper trading only by default. If you go live, you do so at your own risk. The author and contributors are not responsible for any financial loss.
