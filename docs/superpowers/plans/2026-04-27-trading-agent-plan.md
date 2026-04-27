# Implementation Plan — Trading Agent

Date: 2026-04-27
Spec: `docs/superpowers/specs/2026-04-27-trading-agent-design.md`

## Order of work

1. **Hard-fail if not paper** — startup check that `ALPACA_BASE_URL` includes `paper-api`, refuses to run otherwise. Edit in `src/agent.ts` near the existing `invariant` calls.

2. **Guardrail config** — create `config/guardrails.json` with defaults from the spec. Add a loader at `src/guardrails/config.ts` that reads it, validates with zod, falls back to safe defaults on parse error.

3. **State store** — `src/guardrails/state.ts` with read/write of `data/state.json`. Functions: `getTodayState()`, `incrementTradeCount()`, `recomputeIfNewDay(currentPortfolioValue)`, `markCircuitBreakerTripped()`.

4. **Validators** — `src/guardrails/validators.ts` exporting `validateOrder({ ticker, shares, side, currentPrice, account, positions, config, state })`. Returns `{ ok: true } | { ok: false, reason: string }`. Each rule is its own small function for testability.

5. **Tool wrappers** — modify `buyTool`, `sellTool`, `shortSellTool`, `coverShortTool` in `src/agent.ts` to call `validateOrder` before placing the Alpaca order. On reject, return the reason as the tool result.

6. **Kill switch** — add a check at the very top of the main agent loop and at the top of each cycle. Looks for `KILL` or `kill.flag` in the project root. Exits cleanly with a message.

7. **System prompt rewrite** — overwrite `system-prompt.md` with the v2 prompt that mentions hard limits and "default action is hold".

8. **Dashboard server** — `src/dashboard-server.ts`. Express on port 3737. Reads `data/state.json`, the latest CSV report, agent log, and Alpaca portfolio. Renders an HTML page (server-side, no React, just template strings). Add `npm run dashboard:web` script.

9. **Tests** — `tests/guardrails.test.ts` with cases per rule. Mock the Alpaca/OpenAI clients (existing test infra already does this).

10. **Wake-up README** — write `WAKE_UP.md` with the literal steps the user follows to start trading. Update `README.md` to point at it.

11. **`.env.example`** — single template file replacing the multiple `.env.gpt5mini`/`.env.gpt5` files (one less thing to misconfigure).

12. **`npm install`** — run it so the project is ready to go.

13. **Compile check** — `npx tsc --noEmit` (or `npm run build` if available) to verify nothing's broken.

14. **Run guardrail tests** — `npm test -- guardrails` to confirm the new tests pass.

## Files created

- `docs/superpowers/specs/2026-04-27-trading-agent-design.md` ✅ (done)
- `docs/superpowers/plans/2026-04-27-trading-agent-plan.md` ✅ (this file)
- `config/guardrails.json`
- `src/guardrails/config.ts`
- `src/guardrails/state.ts`
- `src/guardrails/validators.ts`
- `src/guardrails/index.ts` (re-exports)
- `src/dashboard-server.ts`
- `tests/guardrails.test.ts`
- `WAKE_UP.md`
- `.env.example`

## Files modified

- `src/agent.ts` — wrap order-placing tools, add kill switch + paper-only check
- `system-prompt.md` — rewritten
- `README.md` — pointer to WAKE_UP.md
- `package.json` — add `dashboard:web` script and `express` + `@types/express` deps

## Files deleted

- `.env.gpt5mini` references in scripts (consolidate to single `.env`)
- The auto-generated trading status block in `README.md` (we replace README, the agent's auto-update can re-add when it runs)

## Definition of done

- `npm install` succeeds.
- `npx tsc --noEmit` passes.
- `npm test -- guardrails` passes.
- `WAKE_UP.md` describes the exact steps, no missing pieces.
- Without API keys, running `npm start` exits with a clear "missing keys, fill .env" message — does NOT trade against fake/mock data.
