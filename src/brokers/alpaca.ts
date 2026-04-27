import Alpaca from "@alpacahq/alpaca-trade-api";
import type {
  Account,
  Broker,
  OrderRecord,
  PlaceOrderArgs,
  PlaceOrderResult,
  Position,
} from "./types.js";

export class AlpacaBroker implements Broker {
  readonly name = "alpaca";

  constructor(private alpaca: Alpaca) {}

  async getAccount(): Promise<Account> {
    const a = await this.alpaca.getAccount();
    return {
      cash: parseFloat(a.cash),
      buyingPower: parseFloat(a.buying_power),
      portfolioValue: parseFloat(a.portfolio_value),
    };
  }

  async getPositions(): Promise<Position[]> {
    const ps = await this.alpaca.getPositions();
    return ps.map((p: any) => ({
      ticker: String(p.symbol).toUpperCase(),
      shares: parseFloat(p.qty),
      marketValue: parseFloat(p.market_value),
      unrealizedPl: parseFloat(p.unrealized_pl),
    }));
  }

  async getOrders(limit = 50): Promise<OrderRecord[]> {
    const orders = await this.alpaca.getOrders({
      status: "all",
      limit,
      nested: true,
      until: null,
      after: null,
      direction: null,
      symbols: null,
    } as any);
    return orders
      .filter((o: any) => o.filled_at)
      .map((o: any) => ({
        id: String(o.id),
        ticker: String(o.symbol).toUpperCase(),
        side: o.side === "buy" ? ("buy" as const) : ("sell" as const),
        shares: parseFloat(o.filled_qty || "0"),
        filledAvgPrice: o.filled_avg_price ? parseFloat(o.filled_avg_price) : null,
        filledAt: o.filled_at ?? null,
        status: String(o.status),
      }));
  }

  async getPrice(ticker: string): Promise<number> {
    const q = await this.alpaca.getLatestQuote(ticker);
    if (q && q.BidPrice && q.AskPrice) {
      return Math.round(((q.BidPrice + q.AskPrice) / 2) * 100) / 100;
    }
    // Fallback to Yahoo
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`
    );
    if (r.ok) {
      const d: any = await r.json();
      const px = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (typeof px === "number" && px > 0) return px;
    }
    throw new Error(`No price for ${ticker}`);
  }

  async placeOrder(args: PlaceOrderArgs): Promise<PlaceOrderResult> {
    const apiSide =
      args.side === "cover_short" ? "buy" : args.side === "short_sell" ? "sell" : args.side;
    const order = await this.alpaca.createOrder({
      symbol: args.ticker.toUpperCase(),
      qty: args.shares,
      side: apiSide,
      type: "market",
      time_in_force: "gtc",
    });
    let estVal = 0;
    try {
      const px = await this.getPrice(args.ticker);
      estVal = px * args.shares;
    } catch {
      /* ignore */
    }
    return {
      id: String(order.id),
      status: String(order.status),
      estimatedValue: estVal,
    };
  }

  async isMarketOpen(): Promise<boolean> {
    try {
      const clock: any = await (this.alpaca as any).getClock();
      return Boolean(clock?.is_open);
    } catch {
      return false;
    }
  }
}
