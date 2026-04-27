// Broker abstraction. Both Alpaca and Paperinvest implement this.
// The agent only ever talks to a Broker — never to a vendor SDK directly.

export type Position = {
  ticker: string;
  shares: number; // negative = short
  marketValue: number;
  unrealizedPl: number;
};

export type Account = {
  cash: number;
  buyingPower: number;
  portfolioValue: number; // total equity = cash + sum(positions market value)
};

export type OrderRecord = {
  id: string;
  ticker: string;
  side: "buy" | "sell";
  shares: number;
  filledAvgPrice: number | null;
  filledAt: string | null;
  status: string;
};

export type PlaceOrderArgs = {
  ticker: string;
  shares: number;
  side: "buy" | "sell" | "short_sell" | "cover_short";
};

export type PlaceOrderResult = {
  id: string;
  status: string;
  estimatedValue: number;
};

export interface Broker {
  name: string;
  getAccount(): Promise<Account>;
  getPositions(): Promise<Position[]>;
  getOrders(limit?: number): Promise<OrderRecord[]>;
  getPrice(ticker: string): Promise<number>;
  placeOrder(args: PlaceOrderArgs): Promise<PlaceOrderResult>;
  isMarketOpen(): Promise<boolean>;
}
