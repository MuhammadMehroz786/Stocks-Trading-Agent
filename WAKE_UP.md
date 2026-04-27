# Wake up — start your trading agent

Everything is built and ready. You need to do three things, total time ~10 minutes:

1. **Sign up for Alpaca paper trading** — gives you $100k of fake money to trade with
2. **Sign up for OpenAI API** — pays for the LLM that makes decisions
3. **Paste two pairs of keys into `.env`, run one command**

That's it. The agent runs only on paper money. Hard-checked at startup — it refuses to trade real money.

---

## 1. Alpaca paper trading account

- Go to https://app.alpaca.markets/signup
- Sign up (just email + password, no SSN, no money)
- After signing in, **make sure you're in Paper Trading mode** — top-left dropdown should say "Paper Trading"
- Left sidebar → "Overview". You should see $100,000 buying power.
- Left sidebar → "Your API keys" (or it might say "API Keys" under your profile)
- Click **Generate New Key**
- Copy the **Key ID** and **Secret Key** (you only see the secret once)

## 2. OpenAI API key

- Go to https://platform.openai.com/
- Sign up / sign in
- Settings → Billing → add **$5–10** of credit (this is enough for many days of trading at 30-min cadence with gpt-5-mini)
- Settings → API Keys → **Create new secret key**
- Copy the key (starts with `sk-`)

## 3. Configure and run

```bash
cd ~/trading-agent

# Copy the template into a real .env
cp .env.example .env

# Edit .env — paste your three keys (Alpaca key, Alpaca secret, OpenAI key)
nano .env   # or open it in any editor
```

Install once:

```bash
npm install
```

Run a single trading session to verify everything works:

```bash
npm start
```

You should see:
- ✅ "Loaded environment from .env"
- 🛡️ "Guardrails loaded: ..."
- 🔑 "OpenAI credentials validated successfully"
- 🔑 "Alpaca credentials validated successfully"
- The agent thinking, looking up prices, maybe placing one or two trades

If markets are closed, it will say so and exit. That's normal.

## Run continuously (every 30 min during market hours)

```bash
npm run start:continuous
```

Stop with `Ctrl+C` at any time, or:

```bash
# panic button — agent exits on next loop tick or session start
touch KILL
```

To resume:
```bash
rm KILL
npm run start:continuous
```

## Watch what it's doing

In another terminal:

```bash
npm run dashboard:web
```

Open http://localhost:3737 — auto-refreshes every 30 seconds. Shows:
- Current portfolio value, today's P&L, # of trades today
- All open positions with unrealized P&L
- Last 20 orders
- Live guardrail config
- Last 50 lines of the agent log

## What the agent will and won't do

**Will:**
- Use GPT-5-mini to read market state and make swing trades on US stocks/ETFs
- Stick to single-order limits, position concentration limits, daily loss circuit breaker
- Refuse leveraged ETFs, penny stocks, and (by default) short selling
- Respect market hours; sleeps overnight and on weekends

**Won't:**
- Touch real money. The Alpaca base URL is checked at startup.
- Place orders bigger than $5k or 5% of portfolio (whichever is smaller)
- Build a position bigger than 15% of the portfolio in any one ticker
- Keep trading after a 3% loss day — circuit breaker stops it until tomorrow
- Place more than 30 orders per day

You can change those numbers in `config/guardrails.json`. They take effect on the next trading cycle without a restart.

## If something goes wrong

- **"OPENAI_API_KEY is not set"** — you didn't paste the key into `.env`, or you saved a different file.
- **"REFUSING TO START: ALPACA_BASE_URL is..."** — your `.env` has a wrong URL. It must include `paper-api.alpaca.markets`.
- **OpenAI 401** — bad key. Regenerate.
- **Alpaca 403** — your account is in live mode. Switch to paper in the Alpaca dashboard.
- **Markets closed** — the agent sleeps until 9:30 AM ET. Normal.
- **Want to stop everything fast** — `touch KILL` in the project directory. Agent exits within a minute.

## Where things live

```
.env                          ← your keys (don't commit)
config/guardrails.json        ← edit limits here, no restart needed
data/state.json               ← today's start-of-day value, trade count, circuit breaker
agent.log / agent-*.log       ← rolling logs
results/                      ← daily P&L CSVs
docs/superpowers/specs/       ← the design doc
docs/superpowers/plans/       ← the implementation plan
src/guardrails/               ← the safety layer (validators, state, config)
src/agent.ts                  ← main agent loop (large, mostly upstream code)
src/dashboard-server.ts       ← the web dashboard
system-prompt.md              ← what the LLM is told
tests/guardrails.test.ts      ← guardrail unit tests; `npm test -- guardrails`
```

## What's next (if you want)

- Switch the LLM to Claude — change `MODEL` and tweak the agent loader. Worth doing if you want better reasoning per dollar.
- Add a Slack/email notification when the circuit breaker trips.
- Add backtesting against historical data before letting it loose.
- Build a multi-agent debate (one bull, one bear, one trader) — the `AlpacaTradingAgent` repo we compared has a working version of this.

But none of those are needed to start. You have a complete, paper-trading, autonomous, guarded LLM agent.

Have fun. Don't switch to live trading without thinking really hard.
