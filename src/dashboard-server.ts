import { config } from "dotenv";
import { existsSync, readFileSync } from "fs";
import { createServer } from "http";
import Alpaca from "@alpacahq/alpaca-trade-api";
import { getCurrentState, isKillSwitchActive, loadGuardrailConfig } from "./guardrails/index.js";

config();

if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
  console.error("Missing ALPACA_API_KEY / ALPACA_SECRET_KEY in .env");
  process.exit(1);
}

const PORT = parseInt(process.env.DASHBOARD_PORT || "3737", 10);

const alpaca = new Alpaca({
  keyId: process.env.ALPACA_API_KEY!,
  secretKey: process.env.ALPACA_SECRET_KEY!,
  paper: true,
  baseUrl: process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets",
});

function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function readLastLogLines(n: number): string[] {
  const candidates = ["agent.log", "logs/agent.log", "agent-gpt5mini.log"];
  for (const p of candidates) {
    if (existsSync(p)) {
      const lines = readFileSync(p, "utf-8").trim().split("\n");
      return lines.slice(-n);
    }
  }
  return ["(no log file yet)"];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function renderHtml(): Promise<string> {
  let account: any = null;
  let positions: any[] = [];
  let orders: any[] = [];
  let alpacaError: string | null = null;
  try {
    [account, positions, orders] = await Promise.all([
      alpaca.getAccount(),
      alpaca.getPositions(),
      alpaca.getOrders({ status: "all", limit: 20, nested: true } as any),
    ]);
  } catch (err) {
    alpacaError = String(err);
  }

  const config = loadGuardrailConfig();
  const state = getCurrentState();
  const kill = isKillSwitchActive();
  const logs = readLastLogLines(50);

  const portfolioValue = account ? parseFloat(account.portfolio_value) : 0;
  const cash = account ? parseFloat(account.cash) : 0;
  const dayPnl = state ? portfolioValue - state.startOfDayValue : 0;
  const dayPnlPct = state && state.startOfDayValue > 0 ? (dayPnl / state.startOfDayValue) * 100 : 0;

  const positionsRows = positions
    .map((p: any) => {
      const qty = parseFloat(p.qty);
      const mv = parseFloat(p.market_value);
      const upl = parseFloat(p.unrealized_pl);
      const uplPct = parseFloat(p.unrealized_plpc) * 100;
      const pnlClass = upl >= 0 ? "pos" : "neg";
      return `<tr><td>${escapeHtml(p.symbol)}</td><td>${qty}</td><td>${fmtUsd(mv)}</td><td class="${pnlClass}">${fmtUsd(upl)} (${uplPct.toFixed(2)}%)</td></tr>`;
    })
    .join("");

  const ordersRows = orders
    .slice(0, 20)
    .map((o: any) => {
      const filled = o.filled_at ? new Date(o.filled_at).toLocaleString() : "—";
      const status = o.status;
      const px = o.filled_avg_price ? `$${parseFloat(o.filled_avg_price).toFixed(2)}` : "—";
      return `<tr><td>${filled}</td><td>${escapeHtml(o.side)}</td><td>${escapeHtml(o.symbol)}</td><td>${o.filled_qty || o.qty}</td><td>${px}</td><td>${escapeHtml(status)}</td></tr>`;
    })
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Trading Agent Dashboard</title>
<meta http-equiv="refresh" content="30">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { margin-bottom: 0; }
  h2 { margin-top: 2.5rem; border-bottom: 1px solid #ddd; padding-bottom: .25rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
  .card { background: #f7f7f9; border-radius: 8px; padding: 1rem; }
  .card .label { font-size: .8rem; color: #666; text-transform: uppercase; }
  .card .value { font-size: 1.4rem; font-weight: 600; margin-top: .25rem; }
  table { width: 100%; border-collapse: collapse; margin-top: .5rem; }
  th, td { text-align: left; padding: .5rem; border-bottom: 1px solid #eee; font-size: .9rem; }
  th { background: #fafafa; }
  .pos { color: #0a7c2f; }
  .neg { color: #c1373a; }
  .alert { background: #fff3cd; border-left: 4px solid #f0ad4e; padding: .75rem 1rem; margin: 1rem 0; }
  .danger { background: #f8d7da; border-left: 4px solid #c1373a; padding: .75rem 1rem; margin: 1rem 0; }
  pre { background: #1e1e1e; color: #d4d4d4; padding: 1rem; border-radius: 6px; overflow: auto; max-height: 400px; font-size: .8rem; }
  .muted { color: #666; font-size: .85rem; }
</style>
</head>
<body>
  <h1>Trading Agent</h1>
  <div class="muted">Auto-refreshes every 30s. Paper trading — no real money.</div>

  ${kill ? `<div class="danger"><strong>KILL switch is active.</strong> Trading is halted. Remove the <code>KILL</code> file to resume.</div>` : ""}
  ${state?.circuitBreakerTripped ? `<div class="danger"><strong>Daily loss circuit breaker tripped.</strong> No more trades today.</div>` : ""}
  ${alpacaError ? `<div class="danger"><strong>Alpaca connection error:</strong> ${escapeHtml(alpacaError)}</div>` : ""}

  <div class="grid">
    <div class="card"><div class="label">Portfolio value</div><div class="value">${fmtUsd(portfolioValue)}</div></div>
    <div class="card"><div class="label">Cash</div><div class="value">${fmtUsd(cash)}</div></div>
    <div class="card"><div class="label">Today's P&amp;L</div><div class="value ${dayPnl >= 0 ? "pos" : "neg"}">${fmtUsd(dayPnl)} (${dayPnlPct.toFixed(2)}%)</div></div>
    <div class="card"><div class="label">Trades today</div><div class="value">${state?.tradesToday ?? 0} / ${config.dailyTradeCountLimit}</div></div>
    <div class="card"><div class="label">Positions</div><div class="value">${positions.length}</div></div>
  </div>

  <h2>Positions</h2>
  ${positions.length === 0 ? '<div class="muted">No open positions.</div>' : `<table><thead><tr><th>Ticker</th><th>Qty</th><th>Market value</th><th>Unrealized P&amp;L</th></tr></thead><tbody>${positionsRows}</tbody></table>`}

  <h2>Recent orders (last 20)</h2>
  ${orders.length === 0 ? '<div class="muted">No orders yet.</div>' : `<table><thead><tr><th>Filled at</th><th>Side</th><th>Ticker</th><th>Qty</th><th>Price</th><th>Status</th></tr></thead><tbody>${ordersRows}</tbody></table>`}

  <h2>Guardrails (current config)</h2>
  <div class="grid">
    <div class="card"><div class="label">Max order USD</div><div class="value">${fmtUsd(config.maxOrderValueUsd)}</div></div>
    <div class="card"><div class="label">Max order %</div><div class="value">${(config.maxOrderPctOfPortfolio * 100).toFixed(1)}%</div></div>
    <div class="card"><div class="label">Max position %</div><div class="value">${(config.maxPositionPctOfPortfolio * 100).toFixed(1)}%</div></div>
    <div class="card"><div class="label">Daily loss limit</div><div class="value">${(config.dailyLossCircuitBreakerPct * 100).toFixed(1)}%</div></div>
    <div class="card"><div class="label">Short selling</div><div class="value">${config.shortSellingEnabled ? "ON" : "OFF"}</div></div>
  </div>
  <div class="muted">Edit <code>config/guardrails.json</code> to change. Reloaded on each trading cycle.</div>

  <h2>Recent agent log (last 50 lines)</h2>
  <pre>${logs.map(escapeHtml).join("\n")}</pre>

</body>
</html>`;
}

const server = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  try {
    const html = await renderHtml();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`Dashboard error: ${err}`);
  }
});

server.listen(PORT, () => {
  console.log(`📊 Dashboard running at http://localhost:${PORT}`);
});
