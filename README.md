# Autonomous LLM Trading Agent

An autonomous AI agent that trades US stocks on Alpaca's **paper trading** account, with a hardened safety/guardrail layer the LLM cannot override.

> **Start here:** [`WAKE_UP.md`](./WAKE_UP.md) — sign-up steps, how to run it, how to stop it.

## What this is

- LLM-driven (default: GPT-5-mini). The model reads portfolio state, looks up prices, optionally web-searches, and places trades.
- Paper trading only. Hard-checked at startup — refuses to run against the live Alpaca endpoint.
- Guardrail layer enforces: max single-order $/% size, max position concentration, daily loss circuit breaker, daily trade count, ticker allow/denylist, no penny stocks, short selling off by default.
- Local web dashboard at http://localhost:3737.
- Built on top of [`matthewchung74/llm_trader`](https://github.com/matthewchung74/llm_trader), with our customizations layered in.

## Quick reference

```bash
npm install                  # one-time
npm start                    # one trading cycle (good for verifying setup)
npm run start:continuous     # 30-min cadence during market hours
npm run dashboard:web        # local dashboard, port 3737
npm test -- guardrails       # run guardrail unit tests
touch KILL                   # panic button — agent exits cleanly
```

Configuration:
- `.env` — API keys (copy from `.env.example`)
- `config/guardrails.json` — risk limits (reloaded each cycle, no restart needed)
- `system-prompt.md` — what the LLM is told

## Documentation

- [`WAKE_UP.md`](./WAKE_UP.md) — start here, end-to-end setup
- [`docs/superpowers/specs/2026-04-27-trading-agent-design.md`](./docs/superpowers/specs/2026-04-27-trading-agent-design.md) — design spec
- [`docs/superpowers/plans/2026-04-27-trading-agent-plan.md`](./docs/superpowers/plans/2026-04-27-trading-agent-plan.md) — implementation plan

## License

MIT, inherited from upstream.
