import type {
  Account,
  Broker,
  OrderRecord,
  PlaceOrderArgs,
  PlaceOrderResult,
  Position,
} from "./types.js";

const BASE = "https://api.paperinvest.io/v1";

type TokenResp = { token: string; refreshToken?: string };

export class PaperinvestBroker implements Broker {
  readonly name = "paperinvest";
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private apiKey: string,
    private portfolioId: string,
    private accountId: string
  ) {}

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const r = await fetch(`${BASE}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: this.apiKey }),
    });
    if (!r.ok) throw new Error(`Paperinvest auth failed: ${r.status} ${await r.text()}`);
    const body = (await r.json()) as TokenResp;
    this.token = body.token;
    // JWTs from this provider are 24h. We refresh after 23h to be safe.
    this.tokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000;
    return this.token;
  }

  private async req<T = any>(
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    const token = await this.getToken();
    const r = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (!r.ok) {
      throw new Error(`Paperinvest ${init.method || "GET"} ${path} -> ${r.status} ${await r.text()}`);
    }
    return (await r.json()) as T;
  }

  async getAccount(): Promise<Account> {
    const p = await this.req<any>(`/accounts/portfolios/${this.portfolioId}`);
    const cash = Number(p.settledCash ?? 0);
    const longMV = Number(p.longMarketValue ?? 0);
    const shortMV = Number(p.shortMarketValue ?? 0);
    // The API's totalEquity is sometimes 0 even when there's cash; compute defensively.
    const portfolioValue = cash + longMV - Math.abs(shortMV);
    return {
      cash,
      buyingPower: cash, // CASH account: buying power == cash
      portfolioValue,
    };
  }

  async getPositions(): Promise<Position[]> {
    const eqs = await this.req<any[]>(
      `/accounts/portfolios/${this.portfolioId}/equities`
    );
    return (eqs || []).map((e: any) => {
      const shares = Number(e.quantity ?? e.shares ?? 0);
      const mv = Number(e.marketValue ?? shares * Number(e.lastPrice ?? 0));
      const upl = Number(e.unrealizedPl ?? e.unrealizedPnl ?? 0);
      return {
        ticker: String(e.symbol ?? e.ticker ?? "").toUpperCase(),
        shares,
        marketValue: mv,
        unrealizedPl: upl,
      };
    });
  }

  async getOrders(limit = 50): Promise<OrderRecord[]> {
    const resp = await this.req<any>(
      `/orders/portfolio/${this.portfolioId}?limit=${limit}`
    );
    const list = Array.isArray(resp) ? resp : resp.orders || [];
    return list.map((o: any) => {
      const intent = String(o.positionIntent ?? "").toUpperCase();
      const side: "buy" | "sell" = intent.startsWith("BUY") ? "buy" : "sell";
      return {
        id: String(o.orderId ?? o.id),
        ticker: String(o.symbol ?? "").toUpperCase(),
        side,
        shares: Number(o.quantity ?? 0),
        filledAvgPrice: o.filledAvgPrice != null ? Number(o.filledAvgPrice) : null,
        filledAt: o.filledAt ?? null,
        status: String(o.status ?? "UNKNOWN"),
      };
    });
  }

  async getPrice(ticker: string): Promise<number> {
    const q = await this.req<any>(`/market-data/quote/${ticker.toUpperCase()}`);
    const last = Number(q.last ?? 0);
    if (last > 0) return last;
    const bid = Number(q.bid ?? 0);
    const ask = Number(q.ask ?? 0);
    if (bid > 0 && ask > 0) return Math.round(((bid + ask) / 2) * 100) / 100;
    throw new Error(`No price available for ${ticker}: ${JSON.stringify(q)}`);
  }

  async placeOrder(args: PlaceOrderArgs): Promise<PlaceOrderResult> {
    const intent =
      args.side === "buy"
        ? "BUY_TO_OPEN"
        : args.side === "sell"
        ? "SELL_TO_CLOSE"
        : args.side === "short_sell"
        ? "SELL_TO_OPEN"
        : "BUY_TO_CLOSE";

    const body = {
      portfolioId: this.portfolioId,
      symbol: args.ticker.toUpperCase(),
      quantity: args.shares,
      orderType: "MARKET",
      positionIntent: intent,
      timeInForce: "DAY",
      assetClass: "EQUITY",
    };

    const o = await this.req<any>(`/orders`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    // Best-effort estimated value (shares * last quote)
    let estVal = 0;
    try {
      const px = await this.getPrice(args.ticker);
      estVal = px * args.shares;
    } catch {
      /* ignore */
    }
    return {
      id: String(o.orderId ?? o.id),
      status: String(o.status ?? "PENDING"),
      estimatedValue: estVal,
    };
  }

  async isMarketOpen(): Promise<boolean> {
    const m = await this.req<any>(`/market-data/market-hours`);
    return Boolean(m.isOpen);
  }
}
