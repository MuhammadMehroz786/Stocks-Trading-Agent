import Alpaca from "@alpacahq/alpaca-trade-api";
import { AlpacaBroker } from "./alpaca.js";
import { PaperinvestBroker } from "./paperinvest.js";
import type { Broker } from "./types.js";

export type { Broker, Account, Position, OrderRecord, PlaceOrderArgs, PlaceOrderResult } from "./types.js";
export { AlpacaBroker, PaperinvestBroker };

export function selectBroker(): Broker {
  const which = (process.env.BROKER || "alpaca").toLowerCase();

  if (which === "paperinvest") {
    const apiKey = process.env.PAPERINVEST_API_KEY;
    const portfolioId = process.env.PAPERINVEST_PORTFOLIO_ID;
    const accountId = process.env.PAPERINVEST_ACCOUNT_ID;
    if (!apiKey || !portfolioId || !accountId) {
      throw new Error(
        "BROKER=paperinvest requires PAPERINVEST_API_KEY, PAPERINVEST_PORTFOLIO_ID, and PAPERINVEST_ACCOUNT_ID"
      );
    }
    return new PaperinvestBroker(apiKey, portfolioId, accountId);
  }

  if (which === "alpaca") {
    const url = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
    if (!url.includes("paper-api.alpaca.markets")) {
      throw new Error(
        `ALPACA_BASE_URL is "${url}". This build only supports paper trading.`
      );
    }
    if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
      throw new Error("BROKER=alpaca requires ALPACA_API_KEY and ALPACA_SECRET_KEY");
    }
    const alpaca = new Alpaca({
      keyId: process.env.ALPACA_API_KEY!,
      secretKey: process.env.ALPACA_SECRET_KEY!,
      paper: true,
      baseUrl: url,
    });
    return new AlpacaBroker(alpaca);
  }

  throw new Error(`Unknown BROKER=${which}. Supported: alpaca, paperinvest.`);
}
