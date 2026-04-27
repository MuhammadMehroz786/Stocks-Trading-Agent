import { Agent, AgentInputItem, run, tool } from "@openai/agents";
import { config } from "dotenv";
import { existsSync, mkdirSync } from "fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import OpenAI from "openai";
import invariant from "tiny-invariant";
import { z } from "zod";
import Alpaca from "@alpacahq/alpaca-trade-api";
import {
  loadGuardrailConfig,
  recomputeIfNewDay,
  incrementTradeCount,
  markCircuitBreakerTripped,
  getCurrentState,
  validateOrder,
  shouldTripCircuitBreaker,
  isKillSwitchActive,
} from "./guardrails/index.js";
import type { Side } from "./guardrails/index.js";
import { selectBroker } from "./brokers/index.js";

// Parse model first to help determine profile name
const modelName = process.env.MODEL || "gpt-4o";

// Get profile name for file isolation - auto-detect from model if not specified or conflicts
const getProfileName = (): string => {
  // If PROFILE_NAME is explicitly set and matches the model type, use it
  if (process.env.PROFILE_NAME) {
    const profileName = process.env.PROFILE_NAME;
    
    // Check if profile name matches model type
    const isValidMatch = 
      (modelName.includes('gpt-4o') && profileName === 'gpt4o') ||
      (modelName.includes('gpt-5') && profileName === 'gpt5mini') ||
      (modelName.includes('gpt-5') && profileName === 'gpt5') ||
      (modelName.includes('claude') && profileName === 'claude') ||
      (profileName === 'default');
    
    if (isValidMatch) {
      return profileName;
    }
    
    // Profile doesn't match model, auto-detect instead
    console.log(`⚠️  PROFILE_NAME=${profileName} doesn't match MODEL=${modelName}, auto-detecting...`);
  }
  
  // Auto-detect profile from model name
  if (modelName.includes('gpt-4o')) {
    return 'gpt4o';
  } else if (modelName.includes('gpt-5-mini')) {
    return 'gpt5mini';
  } else if (modelName.includes('gpt-5')) {
    return 'gpt5';
  } else if (modelName.includes('claude')) {
    return 'claude';
  }
  
  return 'default';
};

const profileName = getProfileName();

// Load profile-specific environment variables
const envFile = profileName === 'default' ? '.env' : `.env.${profileName}`;
if (existsSync(envFile)) {
  config({ path: envFile });
  console.log(`🔧 Loaded environment from ${envFile}`);
} else {
  // Fallback to default .env
  config();
  console.log(`⚠️  ${envFile} not found, using default .env`);
}

console.log(`📁 Using profile: ${profileName} (model: ${modelName})`);

// Validate required environment variables first
invariant(process.env.OPENAI_API_KEY, "OPENAI_API_KEY is not set");

// Broker selection — defaults to alpaca for backwards compatibility.
const SELECTED_BROKER = (process.env.BROKER || "alpaca").toLowerCase();

if (SELECTED_BROKER === "alpaca") {
  invariant(process.env.ALPACA_API_KEY, "ALPACA_API_KEY is not set");
  invariant(process.env.ALPACA_SECRET_KEY, "ALPACA_SECRET_KEY is not set");

  // Hard safety check: refuse to start unless pointed at the paper trading endpoint.
  const ALPACA_BASE_URL = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
  if (!ALPACA_BASE_URL.includes("paper-api.alpaca.markets")) {
    console.error(`🛑 REFUSING TO START: ALPACA_BASE_URL is "${ALPACA_BASE_URL}". This build only supports paper trading.`);
    console.error(`    Set ALPACA_BASE_URL=https://paper-api.alpaca.markets in your .env file.`);
    process.exit(1);
  }
} else if (SELECTED_BROKER === "paperinvest") {
  invariant(process.env.PAPERINVEST_API_KEY, "PAPERINVEST_API_KEY is not set");
  invariant(process.env.PAPERINVEST_PORTFOLIO_ID, "PAPERINVEST_PORTFOLIO_ID is not set");
  invariant(process.env.PAPERINVEST_ACCOUNT_ID, "PAPERINVEST_ACCOUNT_ID is not set");
  // Provide stubbed Alpaca creds so the legacy Alpaca client doesn't crash on init.
  // The paperinvest broker handles every order; the Alpaca client is only kept around
  // for legacy code paths that haven't been migrated yet (price fallback, etc.).
  process.env.ALPACA_API_KEY = process.env.ALPACA_API_KEY || "stub-not-used";
  process.env.ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY || "stub-not-used";
} else {
  console.error(`🛑 Unknown BROKER=${SELECTED_BROKER}. Supported: alpaca, paperinvest.`);
  process.exit(1);
}

// Kill switch check at startup
if (isKillSwitchActive()) {
  console.error(`🛑 KILL switch file present in project root. Remove it (rm KILL or rm kill.flag) to start trading.`);
  process.exit(1);
}

// Load guardrail config once at startup (reloaded each cycle inside the loop in continuous mode).
let guardrailConfig = loadGuardrailConfig();
console.log(`🛡️  Guardrails loaded: max order $${guardrailConfig.maxOrderValueUsd}, daily loss limit ${(guardrailConfig.dailyLossCircuitBreakerPct * 100).toFixed(1)}%, ${guardrailConfig.tickerDenylist.length} denylisted tickers.`);

// Select broker once. All order placement goes through this.
const broker = selectBroker();
console.log(`🏦 Broker: ${broker.name}`);

// Cache configuration
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || "3600"); // 1 hour default
const ENABLE_EXPLICIT_CACHING = process.env.ENABLE_EXPLICIT_CACHING !== "false"; // Enabled by default

// Validate API keys based on model choice

// API credential validation functions
const validateOpenAICredentials = async (): Promise<boolean> => {
  try {
    log("🔑 Validating OpenAI API credentials...");
    const testClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    
    // Make a minimal API call to test credentials
    const response = await testClient.models.list();
    
    if (response.data && response.data.length > 0) {
      log("✅ OpenAI credentials validated successfully");
      return true;
    } else {
      log("❌ OpenAI API responded but no models found");
      return false;
    }
  } catch (error: any) {
    log(`❌ OpenAI credentials validation failed: ${error.message}`);
    if (error.status === 401) {
      log("💡 Error 401: Invalid OpenAI API key. Check your OPENAI_API_KEY environment variable.");
    } else if (error.status === 429) {
      log("💡 Error 429: Rate limited. Your API key may be valid but you've exceeded quota.");
    } else if (error.code === 'ENOTFOUND') {
      log("💡 Network error: Could not reach OpenAI servers. Check your internet connection.");
    }
    return false;
  }
};

const validateGeminiCredentials = async (): Promise<boolean> => {
  try {
    log("🔑 Validating Gemini API credentials...");
    const testClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    
    // Make a minimal API call to test credentials
    const model = testClient.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent("Hello");
    
    if (result.response.text()) {
      log("✅ Gemini credentials validated successfully");
      return true;
    } else {
      log("❌ Gemini API responded but no content generated");
      return false;
    }
  } catch (error: any) {
    log(`❌ Gemini credentials validation failed: ${error.message}`);
    if (error.status === 400 && error.message.includes('API_KEY_INVALID')) {
      log("💡 Invalid Gemini API key. Check your GEMINI_API_KEY environment variable.");
    } else if (error.status === 429) {
      log("💡 Rate limited. Your API key may be valid but you've exceeded quota.");
    } else if (error.code === 'ENOTFOUND') {
      log("💡 Network error: Could not reach Gemini servers. Check your internet connection.");
    }
    return false;
  }
};

const validateAlpacaCredentials = async (): Promise<boolean> => {
  try {
    log("🔑 Validating Alpaca API credentials...");
    
    // Test the connection with account call
    const account = await alpaca.getAccount();
    
    if (account && account.id) {
      log(`✅ Alpaca credentials validated successfully - Account ID: ${account.id}`);
      log(`📊 Account Status: ${account.status}, Buying Power: $${account.buying_power}`);
      return true;
    } else {
      log("❌ Alpaca API responded but no account data found");
      return false;
    }
  } catch (error: any) {
    log(`❌ Alpaca credentials validation failed: ${error.message}`);
    if (error.response?.status === 401) {
      log("💡 Error 401: Invalid Alpaca API credentials. Check your ALPACA_API_KEY and ALPACA_SECRET_KEY.");
    } else if (error.response?.status === 403) {
      log("💡 Error 403: Alpaca API key doesn't have required permissions for paper trading.");
    } else if (error.response?.status === 404) {
      log("💡 Error 404: Wrong Alpaca base URL. Check your ALPACA_BASE_URL environment variable.");
      log(`💡 Current URL: ${process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets'}`);
    } else if (error.code === 'ENOTFOUND') {
      log("💡 Network error: Could not reach Alpaca servers. Check your internet connection.");
    }
    return false;
  }
};

// Comprehensive credential validation function
const validatePaperinvestCredentials = async (): Promise<boolean> => {
  try {
    log("🔑 Validating Paperinvest API credentials...");
    const acct = await broker.getAccount();
    log(`✅ Paperinvest credentials validated — cash $${acct.cash.toFixed(2)}, buying power $${acct.buyingPower.toFixed(2)}`);
    return true;
  } catch (err: any) {
    log(`❌ Paperinvest credentials validation failed: ${err?.message || err}`);
    return false;
  }
};

const validateAllCredentials = async (): Promise<void> => {
  log("🔐 Validating API credentials before starting trading session...");

  const checks: Promise<boolean>[] = [validateOpenAICredentials()];
  if (modelName.includes('gemini')) checks.push(validateGeminiCredentials());
  if (SELECTED_BROKER === 'alpaca') {
    checks.push(validateAlpacaCredentials());
  } else if (SELECTED_BROKER === 'paperinvest') {
    checks.push(validatePaperinvestCredentials());
  }

  const validationResults = await Promise.allSettled(checks);
  let hasErrors = false;
  for (const r of validationResults) {
    if (r.status === 'rejected' || r.value === false) hasErrors = true;
  }
  
  if (hasErrors) {
    log("🚨 CRITICAL: API credential validation failed. Cannot start trading session.");
    log("💡 Please check your environment variables and API keys before retrying.");
    log(`💡 Current profile: ${profileName}, Model: ${modelName}`);
    log(`💡 Environment file: ${envFile}`);
    process.exit(1);
  }
  
  log("✅ All API credentials validated successfully. Starting trading session...");
}

// Create unified client factory for OpenAI and Gemini support
const createAPIClient = (): OpenAI => {
  if (modelName.includes('gemini')) {
    // Use Google AI Studio endpoint for Gemini models
    return new OpenAI({
      apiKey: process.env.GEMINI_API_KEY!,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      defaultHeaders: {
        'Content-Type': 'application/json',
      },
    });
  } else {
    // Default OpenAI client
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
    });
  }
};

// Create native Gemini client
const createNativeGeminiClient = () => {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  return genAI.getGenerativeModel({ 
    model: normalizeModelName(modelName), // Use the normalized model name
    generationConfig: {
      temperature: 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 8192,
    },
  });
};

const client = createAPIClient();

// Initialize Alpaca client for paper trading
// Set environment variables for Alpaca (standard naming)
process.env.APCA_API_KEY_ID = process.env.ALPACA_API_KEY;
process.env.APCA_API_SECRET_KEY = process.env.ALPACA_SECRET_KEY;
process.env.APCA_API_BASE_URL = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';

console.log(`🔧 Alpaca config - Base URL: ${process.env.APCA_API_BASE_URL}, Key ID: ${process.env.APCA_API_KEY_ID?.substring(0, 8)}...`);

const alpaca = new Alpaca({
  paper: true
});

// Cache tracking for analytics
let sessionCacheStats = {
  openaiCachedTokens: 0,
  geminiCacheHits: 0,
  totalRequests: 0
};

const log = (message: string) => {
  message = `[${new Date().toISOString()}] ${message}`;
  console.log(message);
  
  // Ensure results directory exists
  const resultsDir = `results/${profileName}`;
  try {
    if (!existsSync(resultsDir)) {
      mkdirSync(resultsDir, { recursive: true });
    }
    appendFile(`${resultsDir}/agent-${profileName}.log`, message + "\n");
  } catch (error) {
    console.error(`Failed to write to log file: ${error}`);
  }
};

// Cache management for Gemini (currently disabled)
// let geminiCacheId: string | null = null;
// let geminiCacheExpiry: Date | null = null;

const portfolioSchema = z.object({
  cash: z.number(),
  holdings: z.record(z.string(), z.number()),
  history: z.array(
    z.object({
      date: z.string().datetime(),
      type: z.enum(["buy", "sell"]),
      ticker: z.string(),
      shares: z.number(),
      price: z.number(),
      total: z.number(),
    })
  ),
});

// Note: testAlpacaConnection function has been replaced by validateAlpacaCredentials above

// Helper function to get Alpaca account information
// Legacy helper kept for backwards compatibility. Delegates to the broker
// abstraction and reshapes the result to match the old Alpaca account shape.
const getAlpacaAccount = async () => {
  try {
    const acct = await broker.getAccount();
    log(`📊 ${broker.name} account: cash $${acct.cash.toFixed(2)}, buying power $${acct.buyingPower.toFixed(2)}`);
    return {
      status: "ACTIVE",
      cash: String(acct.cash),
      buying_power: String(acct.buyingPower),
      portfolio_value: String(acct.portfolioValue),
      id: broker.name,
    } as any;
  } catch (error: any) {
    log(`❌ Failed to get account from ${broker.name}: ${error.message || error}`);
    throw error;
  }
};

// Legacy helper. Delegates to broker, reshapes to old Alpaca position shape.
const getAlpacaPositions = async () => {
  try {
    const ps = await broker.getPositions();
    log(`📈 Retrieved ${ps.length} positions from ${broker.name}`);
    return ps.map((p) => ({
      symbol: p.ticker,
      qty: String(p.shares),
      market_value: String(p.marketValue),
      unrealized_pl: String(p.unrealizedPl),
    })) as any;
  } catch (error) {
    log(`❌ Failed to get positions from ${broker.name}: ${error}`);
    throw error;
  }
};

// Helper function to create/manage Gemini cache (currently disabled)
// const getOrCreateGeminiCache = async (systemPrompt: string): Promise<string | null> => {
//   // Disable explicit caching for now - Gemini 2.5 has automatic implicit caching
//   // that provides 75% cost savings automatically
//   log(`💡 Gemini explicit caching disabled, using automatic implicit caching (75% savings)`);
//   return null;
// };

// Legacy helper. Delegates to broker, reshapes to old Alpaca order shape.
const getAlpacaOrderHistory = async (limit = 50) => {
  try {
    const orders = await broker.getOrders(limit);
    log(`📋 Retrieved ${orders.length} orders from ${broker.name}`);
    return orders.map((o) => ({
      id: o.id,
      symbol: o.ticker,
      side: o.side,
      filled_qty: o.shares != null ? String(o.shares) : "0",
      filled_avg_price: o.filledAvgPrice != null ? String(o.filledAvgPrice) : "0",
      filled_at: o.filledAt,
      status: o.status,
    })) as any;
  } catch (error) {
    log(`❌ Failed to get orders from ${broker.name}: ${error}`);
    throw error;
  }
};

const webSearch = async (query: string): Promise<string> => {
  try {
    const braveApiKey = process.env.BRAVE_API_KEY;
    if (!braveApiKey) {
      log(`⚠️ BRAVE_API_KEY not found, skipping web search`);
      return "Web search unavailable - API key not configured.";
    }

    const searchUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
    
    const response = await fetch(searchUrl, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': braveApiKey
      }
    });

    if (!response.ok) {
      if (response.status === 429) {
        log(`⚠️ Brave Search rate limit reached, waiting 1 second...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return "Search rate limit reached, please try again in a moment.";
      }
      throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();
    
    // Extract relevant results and format them for trading context
    const results = data.web?.results?.slice(0, 3) || [];
    
    if (results.length === 0) {
      return `No recent news found for "${query}". Consider this in your trading decisions.`;
    }

    const summary = results.map((result: any) => {
      const title = result.title || '';
      const description = result.description || '';
      const url = result.url || '';
      
      // Format for trading relevance
      return `• ${title}\n  ${description}\n  Source: ${new URL(url).hostname}`;
    }).join('\n\n');

    const searchSummary = `Recent search results for "${query}":\n\n${summary}`;
    
    log(`✅ Brave Search found ${results.length} results for: ${query}`);
    return searchSummary;

  } catch (error) {
    log(`❌ Brave Search failed for query "${query}": ${error}`);
    return `Sorry, I couldn't search for information about "${query}" right now. Making trading decisions based on available data.`;
  }
};

const getStockPrice = async (ticker: string): Promise<number> => {
  try {
    const px = await broker.getPrice(ticker);
    log(`✅ Found price for ${ticker}: $${px.toFixed(2)} via ${broker.name}`);
    return Math.round(px * 100) / 100;
  } catch (error) {
    log(`❌ Failed to get stock price for ${ticker}: ${error}`);
    throw error;
  }
};

// Convert Alpaca data to portfolio format for compatibility
const getPortfolio = async (): Promise<z.infer<typeof portfolioSchema>> => {
  try {
    const [account, positions, orders] = await Promise.all([
      getAlpacaAccount(),
      getAlpacaPositions(),
      getAlpacaOrderHistory(100)
    ]);

    // Convert positions to holdings format
    const holdings: Record<string, number> = {};
    positions.forEach((position: any) => {
      if (position.qty && parseFloat(position.qty) !== 0) {
        holdings[position.symbol] = parseFloat(position.qty);
      }
    });

    // Convert orders to history format
    const history = orders
      .filter((order: any) => order.filled_at) // Only include filled orders
      .map((order: any) => ({
        date: order.filled_at,
        type: order.side === 'buy' ? 'buy' as const : 'sell' as const,
        ticker: order.symbol,
        shares: parseFloat(order.filled_qty || '0'),
        price: parseFloat(order.filled_avg_price || '0'),
        total: parseFloat(order.filled_qty || '0') * parseFloat(order.filled_avg_price || '0')
      }))
      .sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());

    return {
      cash: parseFloat(account.cash),
      holdings,
      history
    };
  } catch (error) {
    log(`❌ Failed to get portfolio from Alpaca: ${error}`);
    // Return empty portfolio as fallback
    return {
      cash: 0,
      holdings: {},
      history: []
    };
  }
};

// Guardrail-enforced order placer. Validates against config + state before
// the order hits the broker. Returns a string suitable for return to the LLM.
async function placeGuardedOrder(
  ticker: string,
  shares: number,
  side: Side
): Promise<string> {
  if (isKillSwitchActive()) {
    return `Trade rejected: kill switch is active. Remove the KILL file to resume.`;
  }

  // Reload config each call so changes take effect without a restart.
  guardrailConfig = loadGuardrailConfig();

  const account = await broker.getAccount();
  const positions = await broker.getPositions();
  const currentPrice = await broker.getPrice(ticker);
  const position = positions.find((p) => p.ticker === ticker.toUpperCase());
  const currentSharesOfTicker = position ? position.shares : 0;

  // Refresh day state and check circuit breaker.
  let state = recomputeIfNewDay(account.portfolioValue);
  if (shouldTripCircuitBreaker(state, guardrailConfig) && !state.circuitBreakerTripped) {
    state = markCircuitBreakerTripped();
    log(`🛑 Daily loss circuit breaker tripped at portfolio value $${account.portfolioValue.toFixed(2)} (start of day $${state.startOfDayValue.toFixed(2)}).`);
  }

  const result = validateOrder(
    {
      ticker,
      shares,
      side,
      currentPrice,
      portfolioValue: account.portfolioValue,
      buyingPower: account.buyingPower,
      currentSharesOfTicker,
    },
    guardrailConfig,
    state
  );

  if (!result.ok) {
    log(`🛡️  Guardrail rejected ${side} ${shares} ${ticker}: ${result.reason}`);
    return `Order rejected by guardrails: ${result.reason}`;
  }

  try {
    const order = await broker.placeOrder({ ticker, shares, side });
    incrementTradeCount();
    const verb =
      side === "buy"
        ? "💰 Buy"
        : side === "sell"
        ? "💸 Sell"
        : side === "short_sell"
        ? "📉 Short sell"
        : "📈 Cover short";
    log(`${verb} ${shares} ${ticker} @ ~$${currentPrice.toFixed(2)} via ${broker.name} (Order ID: ${order.id})`);
    const orderValue = shares * currentPrice;
    return `Submitted ${side} order: ${shares} shares of ${ticker} at market via ${broker.name}. Order ID: ${order.id}. Status: ${order.status}. Estimated value: $${orderValue.toFixed(2)}.`;
  } catch (error) {
    log(`❌ ${broker.name} rejected ${side} ${shares} ${ticker}: ${error}`);
    return `Failed to place ${side} order for ${shares} shares of ${ticker}. Error: ${error}`;
  }
}

const getPortfolioTool = tool({
  name: "get_portfolio",
  description: "Get your portfolio",
  parameters: z.object({}) as any,
  async execute() {
    const portfolio = await getPortfolio();
    log(`💹 Fetched portfolio: $${portfolio.cash}`);
    return `Your cash balance is $${portfolio.cash}.
Current holdings:
${Object.entries(portfolio.holdings)
  .map(([ticker, shares]) => `  - ${ticker}: ${shares} shares`)
  .join("\n")}\n\nTrade history:
${portfolio.history
  .map(
    (trade) =>
      `  - ${trade.date} ${trade.type} ${trade.ticker} ${trade.shares} shares at $${trade.price} per share, for a total of $${trade.total}`
  )
  .join("\n")}`;
  },
});

const getNetWorthTool = tool({
  name: "get_net_worth",
  description: "Get your current net worth (total portfolio value)",
  parameters: z.object({}) as any,
  async execute() {
    const netWorth = await calculateNetWorth();
    const portfolio = await getPortfolio();
    const annualizedReturn = await calculateAnnualizedReturn(portfolio);

    log(
      `💰 Current net worth: $${netWorth} (${annualizedReturn}% annualized return)`
    );

    return `Your current net worth is $${netWorth}
- Cash: $${portfolio.cash}
- Holdings value: $${(netWorth - portfolio.cash).toFixed(2)}
- Annualized return: ${annualizedReturn}% (started with $1,000)
- ${netWorth >= 1000 ? "📈 Up" : "📉 Down"} $${Math.abs(
      netWorth - 1000
    ).toFixed(2)} from initial investment`;
  },
});

const buyTool = tool({
  name: "buy",
  description: "Buy a given stock at the current market price using Alpaca paper trading",
  parameters: z.object({
    ticker: z.string(),
    shares: z.number().positive(),
  }) as any,
  async execute(input: any) {
    return placeGuardedOrder(input.ticker.toUpperCase(), input.shares, "buy");
  },
});

const sellTool = tool({
  name: "sell",
  description: "Sell a given stock at the current market price using Alpaca paper trading",
  parameters: z.object({
    ticker: z.string(),
    shares: z.number().positive(),
  }) as any,
  async execute(input: any) {
    return placeGuardedOrder(input.ticker.toUpperCase(), input.shares, "sell");
  },
});

const shortSellTool = tool({
  name: "short_sell",
  description: "Short sell a stock. Disabled by default in guardrails. Warning: unlimited loss potential.",
  parameters: z.object({
    ticker: z.string(),
    shares: z.number().positive(),
  }) as any,
  async execute(input: any) {
    return placeGuardedOrder(input.ticker.toUpperCase(), input.shares, "short_sell");
  },
});

const coverShortTool = tool({
  name: "cover_short",
  description: "Cover (close) a short position by buying back shares.",
  parameters: z.object({
    ticker: z.string(),
    shares: z.number().positive(),
  }) as any,
  async execute(input: any) {
    return placeGuardedOrder(input.ticker.toUpperCase(), input.shares, "cover_short");
  },
});

const getStockPriceTool = tool({
  name: "get_stock_price",
  description: "Get the current price of a given stock ticker",
  parameters: z.object({
    ticker: z.string(),
  }) as any,
  async execute(input: any) {
    const { ticker } = input;
    const price = await getStockPrice(ticker);
    log(`🔖 Searched for stock price for ${ticker}: $${price}`);
    return price;
  },
});

const webSearchTool = tool({
  name: "web_search",
  description: "Search the web for information",
  parameters: z.object({
    query: z.string(),
  }) as any,
  async execute(input: any) {
    const { query } = input;
    log(`🔍 Searching the web for: ${query}`);
    const result = await webSearch(query);
    return result;
  },
});

const thinkTool = tool({
  name: "think",
  description: "Think about a given topic",
  parameters: z.object({
    thought_process: z.array(z.string()),
  }) as any,
  async execute(input: any) {
    const { thought_process } = input;
    thought_process.forEach((thought: string) => log(`🧠 ${thought}`));
    return `Completed thinking with ${thought_process.length} steps of reasoning.`;
  },
});

const calculateNetWorth = async (): Promise<number> => {
  try {
    const account = await getAlpacaAccount();
    const netWorth = parseFloat(account.portfolio_value);
    log(`💰 Current net worth from Alpaca: $${netWorth}`);
    return Math.round(netWorth * 100) / 100;
  } catch (error) {
    log(`❌ Failed to get net worth from Alpaca: ${error}`);
    // Fallback to manual calculation if Alpaca fails
    const portfolio = await getPortfolio();
    let totalHoldingsValue = 0;
    for (const [ticker, shares] of Object.entries(portfolio.holdings)) {
      if (shares > 0) {
        try {
          const price = await getStockPrice(ticker);
          totalHoldingsValue += shares * price;
        } catch (error) {
          log(`⚠️ Failed to get price for ${ticker}: ${error}`);
        }
      }
    }
    const netWorth = Math.round((portfolio.cash + totalHoldingsValue) * 100) / 100;
    return netWorth;
  }
};

const calculateCAGR = (days: number, currentValue: number): number => {
  const startValue = 1000;
  const years = days / 365;
  const cagr = Math.pow(currentValue / startValue, 1 / years) - 1;
  return cagr;
};

const calculateAnnualizedReturn = async (
  portfolio: z.infer<typeof portfolioSchema>
): Promise<string> => {
  if (portfolio.history.length === 0) return "0.00";

  const firstTradeDate = new Date(portfolio.history[0].date);
  const currentDate = new Date();

  let totalHoldingsValue = 0;
  for (const [ticker, shares] of Object.entries(portfolio.holdings))
    if (shares > 0) {
      try {
        const price = await getStockPrice(ticker);
        totalHoldingsValue += shares * price;
      } catch (error) {
        log(`⚠️ Failed to get price for ${ticker}: ${error}`);
      }
    }

  const currentTotalValue = portfolio.cash + totalHoldingsValue;
  log(`💰 Current total value: $${currentTotalValue}`);

  const days =
    (currentDate.getTime() - firstTradeDate.getTime()) / (1000 * 60 * 60 * 24);
  log(`🗓 Days since first trade: ${days.toFixed(2)}`);

  if (days < 1) {
    log("⏳ Not enough time has passed to compute CAGR accurately.");
    return "N/A";
  }

  const cagr = calculateCAGR(days, currentTotalValue);
  log(`💰 CAGR: ${cagr * 100}%`);

  return (cagr * 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

const calculatePortfolioValue = async (): Promise<{
  totalValue: number;
  holdings: Record<string, { shares: number; value: number }>;
}> => {
  try {
    const [account, positions] = await Promise.all([
      getAlpacaAccount(),
      getAlpacaPositions()
    ]);

    const holdingsWithValues: Record<string, { shares: number; value: number }> = {};
    
    // Use Alpaca position data which includes market values
    for (const position of positions) {
      if (parseFloat(position.qty) > 0) {
        holdingsWithValues[position.symbol] = {
          shares: parseFloat(position.qty),
          value: Math.round(parseFloat(position.market_value) * 100) / 100
        };
      }
    }

    const totalValue = Math.round(parseFloat(account.portfolio_value) * 100) / 100;
    return { totalValue, holdings: holdingsWithValues };
  } catch (error) {
    log(`❌ Failed to get portfolio value from Alpaca: ${error}`);
    // Fallback to manual calculation
    const portfolio = await getPortfolio();
    const holdingsWithValues: Record<string, { shares: number; value: number }> = {};
    let totalHoldingsValue = 0;

    for (const [ticker, shares] of Object.entries(portfolio.holdings)) {
      if (shares > 0) {
        try {
          const price = await getStockPrice(ticker);
          const value = Math.round(shares * price * 100) / 100;
          holdingsWithValues[ticker] = { shares, value };
          totalHoldingsValue += value;
        } catch (error) {
          log(`⚠️ Failed to get price for ${ticker}: ${error}`);
          holdingsWithValues[ticker] = { shares, value: 0 };
        }
      }
    }

    const totalValue = Math.round((portfolio.cash + totalHoldingsValue) * 100) / 100;
    return { totalValue, holdings: holdingsWithValues };
  }
};

const loadThread = async (): Promise<AgentInputItem[]> => {
  const threadFile = `results/${profileName}/thread-${profileName}.json`;
  try {
    if (existsSync(threadFile)) {
      const threadData = await readFile(threadFile, "utf-8");
      const fullThread = JSON.parse(threadData);
      
      // Check for thread corruption indicators
      const hasCorruption = fullThread.some((item: any) => 
        item.callId === 'call_en9S0pLVBoYjEcU4hnyuVl5X' || // GPT-4o specific corruption
        (item.type === 'function_call_result' && !fullThread.find((call: any) => call.callId === item.callId && call.type === 'function_call'))
      );
      
      if (hasCorruption) {
        log(`🔧 Thread corruption detected (stale tool call IDs), resetting thread for clean start`);
        // Move corrupted thread to backup
        await writeFile(`${threadFile}.corrupted-${Date.now()}`, threadData);
        return [];
      }
      
      // For thread history issues, start fresh to avoid tool call ID mismatches
      if (fullThread.length > 50) {
        log(`📝 Thread history too large (${fullThread.length} items), starting fresh to avoid token issues`);
        return [];
      }
      
      return fullThread;
    }
  } catch (error) {
    log(`⚠️ Failed to load thread history: ${error}`);
  }
  return [];
};

const saveThread = async (thread: AgentInputItem[]) => {
  const threadFile = `results/${profileName}/thread-${profileName}.json`;
  try {
    // Limit thread size to prevent unbounded growth and reduce token usage
    const maxItems = 12; // ~3 conversations worth of context (reduced from 40 to save tokens)
    const trimmedThread = thread.slice(-maxItems);
    
    await writeFile(threadFile, JSON.stringify(trimmedThread, null, 2));
    
    if (thread.length > maxItems) {
      log(`💾 Saved thread history (${thread.length} → ${trimmedThread.length} items, trimmed to last 3 sessions)`);
    } else {
      log(`💾 Saved thread history (${thread.length} items)`);
    }
  } catch (error) {
    log(`❌ Failed to save thread history: ${error}`);
  }
};

const updateReadme = async () => {
  const readmeFile = `results/${profileName}/README-${profileName}.md`;
  try {
    const portfolio = await getPortfolio();
    const { totalValue, holdings } = await calculatePortfolioValue();
    
    // Create profile-specific README.md if it doesn't exist
    let readmeContent;
    if (existsSync(readmeFile)) {
      readmeContent = await readFile(readmeFile, "utf-8");
    } else {
      // Create default README template
      readmeContent = `# AI Trading Agent - ${profileName.toUpperCase()} Profile

An autonomous AI-powered stock trading agent using **${modelName}** that executes trades automatically via Alpaca's paper trading API.

## Overview

This trading agent (${profileName} profile) starts with virtual capital and attempts to grow the portfolio through strategic trading decisions. All trades are executed on Alpaca's paper trading platform using real market data.

<!-- auto start -->
<!-- auto end -->

## Features

- 🤖 Autonomous trading using ${modelName}
- 📊 Real-time market data and analysis
- 💰 Paper trading through Alpaca API
- 📈 Automated portfolio tracking and reporting
- 🧠 Strategic decision-making with risk management

## Setup

1. Clone the repository
2. Install dependencies: \`npm install\`
3. Configure environment variables in \`.env.${profileName}\`
4. Run the agent: \`dotenv -e .env.${profileName} npm start\`

## Trading Strategy

The agent follows a momentum-based trading strategy, focusing on:
- Technical analysis and market trends
- News-driven opportunities
- Risk management and diversification
- Continuous learning from trading results
`;
      log(`📝 Created new ${readmeFile} file`);
    }
    const recentTrades = portfolio.history.slice(-20).reverse();
    const annualizedReturn = await calculateAnnualizedReturn(portfolio);
    const portfolioSection = `<!-- auto start -->

## 💰 Portfolio value: $${totalValue.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}** (${annualizedReturn}% CAGR)

### 📊 Holdings

| Asset | Shares | Value |
|-------|--------|-------|
| Cash | - | $${portfolio.cash.toFixed(2)} |
${Object.entries(holdings)
  .map(
    ([ticker, data]) =>
      `| ${ticker} | ${data.shares} | $${data.value.toFixed(2)} |`
  )
  .join("\n")}

### 📈 Recent trades

${
  recentTrades.length > 0
    ? recentTrades
        .map((trade) => {
          let pnlText = "";
          
          if (trade.type === "sell") {
            // Calculate P&L for sell trades by finding matching buy trades
            const buyTrades = portfolio.history
              .filter(t => t.ticker === trade.ticker && t.type === "buy" && new Date(t.date) < new Date(trade.date))
              .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()); // Most recent first
            
            if (buyTrades.length > 0) {
              // Use weighted average cost basis for simplicity
              const totalBuyShares = buyTrades.reduce((sum, t) => sum + t.shares, 0);
              const totalBuyCost = buyTrades.reduce((sum, t) => sum + t.total, 0);
              const avgBuyPrice = totalBuyShares > 0 ? totalBuyCost / totalBuyShares : 0;
              
              const pnl = (trade.price - avgBuyPrice) * trade.shares;
              const pnlPercent = avgBuyPrice > 0 ? ((trade.price - avgBuyPrice) / avgBuyPrice) * 100 : 0;
              const pnlEmoji = pnl >= 0 ? "📈" : "📉";
              const pnlSign = pnl >= 0 ? "+" : "";
              
              pnlText = ` ${pnlEmoji} **P&L: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPercent.toFixed(2)}%)**`;
            }
          }
          
          return `- **${new Date(trade.date).toLocaleString("en-US", {
            timeZone: "UTC",
            dateStyle: "long",
            timeStyle: "medium",
          })}**: ${trade.type.toUpperCase()} ${trade.shares} ${
            trade.ticker
          } @ $${trade.price}/share ($${trade.total.toFixed(2)})${pnlText}`;
        })
        .slice(0, 10)
        .join("\n")
    : "- No trades yet"
}

<!-- auto end -->`;

    const updatedReadme = readmeContent.replace(
      /<!-- auto start -->[\s\S]*<!-- auto end -->/,
      portfolioSection
    );

    await writeFile(readmeFile, updatedReadme);
    log(`📝 Updated ${readmeFile} with portfolio value: $${totalValue}`);
  } catch (error) {
    log(`❌ Failed to update README: ${error}`);
  }
};

// Generate CSV P&L report for the current model
const generateCSVReport = async () => {
  try {
    // Get portfolio data from Alpaca
    const portfolio = await getPortfolio();
    
    if (!portfolio.history || portfolio.history.length === 0) {
      log("📊 No trades found for CSV report");
      return;
    }

    const modelSafe = modelName.replace(/[^a-zA-Z0-9-]/g, '_');
    const filename = `results/${profileName}/pnl_${modelSafe}_${new Date().toISOString().split('T')[0]}.csv`;
    
    const csvHeader = 'Date,Type,Ticker,Shares,Price,Total,Model,P&L,P&L_Percent,Cache_Enabled,Cache_TTL\n';
    
    const csvRows = portfolio.history.map(trade => {
      let pnl = '';
      let pnlPercent = '';
      
      if (trade.type === 'sell') {
        // Calculate P&L for sell trades
        const buyTrades = portfolio.history
          .filter(t => t.ticker === trade.ticker && t.type === 'buy' && new Date(t.date) < new Date(trade.date))
          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        
        if (buyTrades.length > 0) {
          const totalBuyShares = buyTrades.reduce((sum, t) => sum + t.shares, 0);
          const totalBuyCost = buyTrades.reduce((sum, t) => sum + t.total, 0);
          const avgBuyPrice = totalBuyShares > 0 ? totalBuyCost / totalBuyShares : 0;
          
          const calculatedPnl = (trade.price - avgBuyPrice) * trade.shares;
          const calculatedPnlPercent = avgBuyPrice > 0 ? ((trade.price - avgBuyPrice) / avgBuyPrice) * 100 : 0;
          
          pnl = calculatedPnl.toFixed(2);
          pnlPercent = calculatedPnlPercent.toFixed(2);
        }
      }
      
      const cacheEnabled = modelName.includes('gemini') ? ENABLE_EXPLICIT_CACHING : 'auto';
      const cacheTTL = modelName.includes('gemini') ? CACHE_TTL_SECONDS : 'auto';
      return `${trade.date},${trade.type},${trade.ticker},${trade.shares},${trade.price},${trade.total},${modelName},"${pnl}","${pnlPercent}",${cacheEnabled},${cacheTTL}`;
    });
    
    const csvContent = csvHeader + csvRows.join('\n');
    await writeFile(filename, csvContent);
    log(`📊 Generated CSV P&L report: ${filename}`);
  } catch (error) {
    log(`❌ Failed to generate CSV report: ${error}`);
  }
};

// Normalize model name for API calls based on actual availability
function normalizeModelName(modelName: string): string {
  // Gemini models available via Google AI Studio OpenAI-compatible endpoint
  if (modelName.includes('gemini-2.5-pro')) {
    return 'gemini-2.5-pro';
  } else if (modelName.includes('gemini-2.5-flash')) {
    return 'gemini-2.5-flash';
  } else if (modelName.includes('gemini-2.0-flash')) {
    return 'gemini-2.0-flash';
  } else if (modelName.includes('gemini-1.5-flash')) {
    return 'gemini-1.5-flash';
  } else if (modelName.includes('gemini-1.5')) {
    return 'gemini-1.5-pro';
  } else if (modelName.includes('gemini')) {
    return 'gemini-2.5-flash'; // Default to Gemini 2.5 Flash
  }
  return modelName; // Return as-is for OpenAI models
}

const normalizedModel = normalizeModelName(modelName);

// Log which model and client are being used
log(`🤖 Using model: ${modelName} (normalized: ${normalizedModel})`);
if (modelName.includes('gemini')) {
  log(`🔗 Using Google AI Studio endpoint for Gemini models`);
} else {
  log(`🔗 Using OpenAI API`);
}

// Create agent configuration (only for OpenAI models)
let agent: Agent | null = null;

if (!modelName.includes('gemini')) {
  const agentConfig: any = {
    name: "Assistant",
    model: normalizedModel,
    instructions: await readFile("system-prompt.md", "utf-8"),
    tools: [
      thinkTool,
      webSearchTool,
      buyTool,
      sellTool,
      shortSellTool,
      coverShortTool,
      getStockPriceTool,
      getPortfolioTool,
      getNetWorthTool,
    ],
    // Enable structured reasoning for function calls
    tool_choice: "auto",
    parallel_tool_calls: false
  };
  
  // Only add custom client for non-OpenAI models (shouldn't happen since we filtered out Gemini)
  if (!modelName.startsWith('gpt-')) {
    agentConfig.client = client;
  }
  
  agent = new Agent(agentConfig);
  log(`🤖 Created OpenAI Agent with model: ${normalizedModel}`);
} else {
  log(`🤖 Using custom Gemini implementation with model: ${normalizedModel}`);
}

// Parse command line arguments
const args = process.argv.slice(2);
const continuousMode = args.includes('--continuous') || args.includes('-c');
const intervalMinutes = parseInt(args.find(arg => arg.startsWith('--interval='))?.split('=')[1] || '30');

// Validate interval
if (intervalMinutes < 5) {
  log("❌ Interval must be at least 5 minutes");
  process.exit(1);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Parse Gemini's tool_code format: "print(function_name(args))"
const parseToolCodeString = (toolCode: string): {name: string, args: any} | null => {
  try {
    // Remove print() wrapper if present
    let cleaned = toolCode.replace(/^print\((.*)\)$/, '$1');
    
    // Parse function name and arguments
    const functionMatch = cleaned.match(/^(\w+)\((.*)\)$/);
    if (!functionMatch) {
      log(`⚠️ Could not parse tool_code format: ${toolCode}`);
      return null;
    }
    
    const [, functionName, argsString] = functionMatch;
    let args = {};
    
    // Parse arguments if present
    if (argsString.trim()) {
      try {
        // Handle simple cases like query='some string'
        // Split by comma but be careful about commas inside quotes
        const args_temp = {};
        let currentPair = '';
        let inQuotes = false;
        let quoteChar = '';
        
        for (let i = 0; i < argsString.length; i++) {
          const char = argsString[i];
          if ((char === '"' || char === "'") && (i === 0 || argsString[i-1] !== '\\')) {
            if (!inQuotes) {
              inQuotes = true;
              quoteChar = char;
            } else if (char === quoteChar) {
              inQuotes = false;
              quoteChar = '';
            }
          }
          
          if (char === ',' && !inQuotes) {
            // Process current pair
            if (currentPair.trim()) {
              const [key, ...valueParts] = currentPair.split('=');
              if (key && valueParts.length > 0) {
                let value = valueParts.join('=').trim();
                // Remove quotes if present
                if ((value.startsWith("'") && value.endsWith("'")) || 
                    (value.startsWith('"') && value.endsWith('"'))) {
                  value = value.slice(1, -1);
                }
                args_temp[key.trim()] = value;
              }
            }
            currentPair = '';
          } else {
            currentPair += char;
          }
        }
        
        // Process final pair
        if (currentPair.trim()) {
          const [key, ...valueParts] = currentPair.split('=');
          if (key && valueParts.length > 0) {
            let value = valueParts.join('=').trim();
            // Remove quotes if present
            if ((value.startsWith("'") && value.endsWith("'")) || 
                (value.startsWith('"') && value.endsWith('"'))) {
              value = value.slice(1, -1);
            }
            args_temp[key.trim()] = value;
          }
        }
        
        args = args_temp;
      } catch (parseError) {
        log(`⚠️ Could not parse arguments in tool_code: ${argsString}`);
      }
    }
    
    log(`🔧 Parsed tool_code: ${functionName} with args:`, args);
    return { name: functionName, args };
    
  } catch (error) {
    log(`❌ Error parsing tool_code: ${error}`);
    return null;
  }
};

// Parse text response for JSON tool calls
const parseTextForToolCalls = async (text: string): Promise<Array<{name: string, args: any}>> => {
  const toolCalls = [];
  log(`🔍 Parsing text for tool calls. Text length: ${text.length}`);
  
  try {
    // Look for JSON blocks in the text
    const jsonRegex = /```json\s*({[\s\S]*?})\s*```/g;
    let match;
    log(`🔍 Searching for JSON blocks with regex...`);
    
    while ((match = jsonRegex.exec(text)) !== null) {
      log(`🔍 Found JSON block: ${match[1]}`);
      try {
        const jsonObj = JSON.parse(match[1]);
        log(`🔍 Parsed JSON object:`, jsonObj);
        if (jsonObj.tool && jsonObj.parameters) {
          toolCalls.push({
            name: jsonObj.tool,
            args: jsonObj.parameters
          });
          log(`✅ Parsed tool call: ${jsonObj.tool}`);
        } else {
          log(`⚠️ JSON object missing 'tool' or 'parameters' properties`);
        }
      } catch (parseError) {
        log(`❌ Failed to parse JSON tool call: ${parseError}`);
      }
    }
    
    // Also look for direct JSON objects without code blocks
    log(`🔍 Searching for direct JSON objects...`);
    const directJsonRegex = /{\s*"tool"\s*:[\s\S]*?"parameters"\s*:[\s\S]*?}/g;
    let directMatch;
    
    while ((directMatch = directJsonRegex.exec(text)) !== null) {
      log(`🔍 Found direct JSON: ${directMatch[0]}`);
      try {
        const jsonObj = JSON.parse(directMatch[0]);
        if (jsonObj.tool && jsonObj.parameters) {
          toolCalls.push({
            name: jsonObj.tool,
            args: jsonObj.parameters
          });
          log(`✅ Parsed direct tool call: ${jsonObj.tool}`);
        }
      } catch (parseError) {
        log(`❌ Failed to parse direct JSON tool call: ${parseError}`);
      }
    }
    
    // Look for Gemini's tool_code format: [{"tool_code": "print(function_name(args))"}]
    log(`🔍 Searching for Gemini tool_code format...`);
    const toolCodeRegex = /\[\s*{\s*"tool_code"\s*:\s*"([^"]+)"\s*}\s*(?:,\s*{\s*"tool_code"\s*:\s*"([^"]+)"\s*}\s*)*\]/g;
    let toolCodeMatch;
    
    while ((toolCodeMatch = toolCodeRegex.exec(text)) !== null) {
      log(`🔍 Found tool_code array: ${toolCodeMatch[0]}`);
      try {
        const toolCodeArray = JSON.parse(toolCodeMatch[0]);
        for (const item of toolCodeArray) {
          if (item.tool_code) {
            const parsed = parseToolCodeString(item.tool_code);
            if (parsed) {
              toolCalls.push(parsed);
              log(`✅ Parsed tool_code: ${parsed.name}`);
            }
          }
        }
      } catch (parseError) {
        log(`❌ Failed to parse tool_code array: ${parseError}`);
      }
    }
    
  } catch (error) {
    log(`❌ Error parsing text for tool calls: ${error}`);
  }
  
  log(`🔍 Final result: ${toolCalls.length} tool calls parsed`);
  return toolCalls;
};

// Execute a single tool call
const executeToolCall = async (name: string, args: any): Promise<string> => {
  log(`🛠️ Executing function: ${name}`);
  
  try {
    switch (name) {
      case "think":
        const thoughts = args.thought_process || args.thoughts || [];
        thoughts.forEach((thought: string) => log(`🧠 ${thought}`));
        return `Completed thinking with ${thoughts.length} steps of reasoning.`;
        
      case "get_stock_price":
        const ticker = args.ticker || args.tickers;
        if (Array.isArray(ticker)) {
          const prices = [];
          for (const t of ticker) {
            try {
              const price = await getStockPrice(t);
              prices.push(`${t}: $${price}`);
              log(`🔖 Searched for stock price for ${t}: $${price}`);
            } catch (error) {
              prices.push(`${t}: Error - ${error}`);
              log(`❌ Failed to get price for ${t}: ${error}`);
            }
          }
          return prices.join('\n');
        } else {
          const price = await getStockPrice(ticker);
          log(`🔖 Searched for stock price for ${ticker}: $${price}`);
          return `${ticker}: $${price}`;
        }
        
      case "get_portfolio":
        const portfolio = await getPortfolio();
        log(`💹 Fetched portfolio: $${portfolio.cash}`);
        return `Your cash balance is $${portfolio.cash}.
Current holdings:
${Object.entries(portfolio.holdings)
          .map(([ticker, shares]) => `  - ${ticker}: ${shares} shares`)
          .join("\n")}

Trade history:
${portfolio.history
          .map(
            (trade) =>
              `  - ${trade.date} ${trade.type} ${trade.ticker} ${trade.shares} shares at $${trade.price} per share, for a total of $${trade.total}`
          )
          .join("\n")}`;
          
      case "get_net_worth":
        const netWorth = await calculateNetWorth();
        const portfolioForReturn = await getPortfolio();
        const annualizedReturn = await calculateAnnualizedReturn(portfolioForReturn);
        log(`💰 Current net worth: $${netWorth} (${annualizedReturn}% annualized return)`);
        return `Your current net worth is $${netWorth}
- Cash: $${portfolioForReturn.cash}
- Holdings value: $${(netWorth - portfolioForReturn.cash).toFixed(2)}
- Annualized return: ${annualizedReturn}% (started with $1,000)
- ${netWorth >= 1000 ? "📈 Up" : "📉 Down"} $${Math.abs(netWorth - 1000).toFixed(2)} from initial investment`;
        
      case "web_search":
        const query = args.query;
        log(`🔍 Searching the web for: ${query}`);
        return await webSearch(query);
        
      case "buy":
        const buyTicker = args.ticker;
        const buyShares = args.quantity || args.shares;
        try {
          const account = await getAlpacaAccount();
          const price = await getStockPrice(buyTicker);
          const orderValue = buyShares * price;

          if (parseFloat(account.buying_power) < orderValue) {
            return `You don't have enough buying power to buy ${buyShares} shares of ${buyTicker}. Your buying power is $${account.buying_power} and the estimated cost is $${orderValue.toFixed(2)}.`;
          }

          const order = await alpaca.createOrder({
            symbol: buyTicker,
            qty: buyShares,
            side: 'buy',
            type: 'market',
            time_in_force: 'gtc'
          });

          log(`💰 Submitted buy order for ${buyShares} shares of ${buyTicker} (Order ID: ${order.id})`);
          return `Submitted buy order for ${buyShares} shares of ${buyTicker} at market price. Order ID: ${order.id}. Status: ${order.status}. Estimated cost: $${orderValue.toFixed(2)}.`;
        } catch (error) {
          log(`❌ Failed to buy ${buyShares} shares of ${buyTicker}: ${error}`);
          return `Failed to place buy order for ${buyShares} shares of ${buyTicker}. Error: ${error}`;
        }
        
      case "sell":
        const sellTicker = args.ticker;
        const sellShares = args.quantity || args.shares;
        try {
          const positions = await getAlpacaPositions();
          const position = positions.find(p => p.symbol === sellTicker);
          
          if (!position || parseFloat(position.qty) < sellShares) {
            const currentShares = position ? parseFloat(position.qty) : 0;
            return `You don't have enough shares of ${sellTicker} to sell. You have ${currentShares} shares.`;
          }

          const price = await getStockPrice(sellTicker);
          const orderValue = sellShares * price;

          const order = await alpaca.createOrder({
            symbol: sellTicker,
            qty: sellShares,
            side: 'sell',
            type: 'market',
            time_in_force: 'gtc'
          });

          log(`💸 Submitted sell order for ${sellShares} shares of ${sellTicker} (Order ID: ${order.id})`);
          return `Submitted sell order for ${sellShares} shares of ${sellTicker} at market price. Order ID: ${order.id}. Status: ${order.status}. Estimated proceeds: $${orderValue.toFixed(2)}.`;
        } catch (error) {
          log(`❌ Failed to sell ${sellShares} shares of ${sellTicker}: ${error}`);
          return `Failed to place sell order for ${sellShares} shares of ${sellTicker}. Error: ${error}`;
        }
        
      default:
        log(`❌ Unknown function requested: ${name}`);
        return `Unknown function: ${name}`;
    }
  } catch (error) {
    log(`❌ Function ${name} failed: ${error}`);
    return `Function execution failed: ${error}`;
  }
};

const withRetry = async <T>(fn: () => Promise<T>, retries = 5, delay = 2000): Promise<T> => {
  let lastError: any;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      
      let status = error.status;
      if (!status && error.message) {
        const match = error.message.match(/(\d{3}) status code/);
        if (match) {
          status = parseInt(match[1], 10);
        }
      }

      // Check for 429 (rate limiting) or 5xx (server errors)
      if (status === 429 || (status >= 500 && status < 600)) {
        const waitTime = delay * Math.pow(2, i) + Math.random() * 1000; // Add jitter
        log(`⚠️ API error status ${status}. Retrying in ${Math.round(waitTime / 1000)}s... (Attempt ${i + 1}/${retries})`);
        await sleep(waitTime);
      } else {
        // Don't retry for other errors (e.g., 400 bad request)
        throw error;
      }
    }
  }
  log(`❌ API call failed after ${retries} retries.`);
  throw lastError;
};

// Market hours detection
const isMarketOpen = (): boolean => {
  // Testing mode: Allow 24/7 trading for testing purposes
  if (process.env.TESTING_MODE === 'true') {
    return true;
  }
  
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  
  // Check if it's a weekend (Saturday = 6, Sunday = 0)
  const dayOfWeek = et.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return false;
  }
  
  // Market hours: 9:30 AM - 4:00 PM ET
  const hours = et.getHours();
  const minutes = et.getMinutes();
  const timeInMinutes = hours * 60 + minutes;
  
  const marketOpen = 9 * 60 + 30; // 9:30 AM
  const marketClose = 16 * 60; // 4:00 PM
  
  return timeInMinutes >= marketOpen && timeInMinutes < marketClose;
};

const getNextMarketOpen = (): Date => {
  const now = new Date();
  
  // If markets are currently open, next open is tomorrow
  if (isMarketOpen()) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const nextOpen = new Date(Date.UTC(
      tomorrow.getFullYear(),
      tomorrow.getMonth(), 
      tomorrow.getDate(),
      13, 30, 0, 0  // 9:30 AM ET = 13:30 UTC (EDT)
    ));
    
    // Handle weekends
    if (nextOpen.getDay() === 6) {
      nextOpen.setDate(nextOpen.getDate() + 2);
    } else if (nextOpen.getDay() === 0) {
      nextOpen.setDate(nextOpen.getDate() + 1);
    }
    
    return nextOpen;
  }
  
  // Markets are closed, check if today's market hasn't opened yet
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dayOfWeek = et.getDay();
  const hours = et.getHours();
  const minutes = et.getMinutes();
  const timeInMinutes = hours * 60 + minutes;
  const marketOpen = 9 * 60 + 30; // 9:30 AM
  
  // If it's a weekday and before market open, market opens today
  if (dayOfWeek >= 1 && dayOfWeek <= 5 && timeInMinutes < marketOpen) {
    // Use the ET date components for today's market open
    return new Date(Date.UTC(
      et.getFullYear(),
      et.getMonth(), 
      et.getDate(),
      13, 30, 0, 0  // 9:30 AM ET = 13:30 UTC (EDT)
    ));
  }
  
  // Market is closed for today, next open is tomorrow
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const nextOpen = new Date(Date.UTC(
    tomorrow.getFullYear(),
    tomorrow.getMonth(), 
    tomorrow.getDate(),
    13, 30, 0, 0  // 9:30 AM ET = 13:30 UTC (EDT)
  ));
  
  // Handle weekends
  if (nextOpen.getDay() === 6) {
    nextOpen.setDate(nextOpen.getDate() + 2);
  } else if (nextOpen.getDay() === 0) {
    nextOpen.setDate(nextOpen.getDate() + 1);
  }
  
  return nextOpen;
};

// Parse and execute simple text commands from Gemini
const parseAndExecuteCommands = async (text: string): Promise<void> => {
  // Extract commands from the entire text, not just line by line
  const commands = [];
  
  // Find BUY commands
  const buyMatches = text.match(/BUY\s+([A-Z]+)\s+(\d+)/gi);
  if (buyMatches) {
    buyMatches.forEach(match => {
      const parts = match.match(/BUY\s+([A-Z]+)\s+(\d+)/i);
      if (parts) {
        commands.push({ type: 'BUY', ticker: parts[1], shares: parseInt(parts[2]) });
      }
    });
  }
  
  // Find SELL commands
  const sellMatches = text.match(/SELL\s+([A-Z]+)\s+(\d+)/gi);
  if (sellMatches) {
    sellMatches.forEach(match => {
      const parts = match.match(/SELL\s+([A-Z]+)\s+(\d+)/i);
      if (parts) {
        commands.push({ type: 'SELL', ticker: parts[1], shares: parseInt(parts[2]) });
      }
    });
  }
  
  // Find PRICE commands
  const priceMatches = text.match(/PRICE\s+([A-Z]+)/gi);
  if (priceMatches) {
    priceMatches.forEach(match => {
      const parts = match.match(/PRICE\s+([A-Z]+)/i);
      if (parts) {
        commands.push({ type: 'PRICE', ticker: parts[1] });
      }
    });
  }
  
  // Find SEARCH commands
  const searchMatches = text.match(/SEARCH\s+([^\n]+)/gi);
  if (searchMatches) {
    searchMatches.forEach(match => {
      const parts = match.match(/SEARCH\s+(.+)/i);
      if (parts) {
        commands.push({ type: 'SEARCH', query: parts[1].trim() });
      }
    });
  }
  
  // Find THINK commands
  if (text.match(/THINK/i)) {
    commands.push({ type: 'THINK' });
  }
  
  // Execute commands in order
  for (const command of commands) {
    try {
      switch (command.type) {
        case 'BUY':
          log(`🛠️ Executing BUY command: ${command.ticker} ${command.shares} shares`);
          try {
            const account = await getAlpacaAccount();
            const price = await getStockPrice(command.ticker);
            const orderValue = command.shares * price;

            // Check if we have enough buying power
            if (parseFloat(account.buying_power) < orderValue) {
              log(`❌ Not enough buying power to buy ${command.shares} shares of ${command.ticker}. Your buying power is $${account.buying_power} and the estimated cost is $${orderValue.toFixed(2)}.`);
            } else {
              // Create market buy order through Alpaca
              const order = await alpaca.createOrder({
                symbol: command.ticker,
                qty: command.shares,
                side: 'buy',
                type: 'market',
                time_in_force: 'gtc'
              });

              log(`💰 Submitted buy order for ${command.shares} shares of ${command.ticker} (Order ID: ${order.id})`);
              log(`✅ Buy result: Submitted buy order for ${command.shares} shares of ${command.ticker} at market price. Order ID: ${order.id}. Status: ${order.status}. Estimated cost: $${orderValue.toFixed(2)}.`);
            }
          } catch (error) {
            log(`❌ Failed to buy ${command.shares} shares of ${command.ticker}: ${error}`);
          }
          break;
          
        case 'SELL':
          log(`🛠️ Executing SELL command: ${command.ticker} ${command.shares} shares`);
          try {
            const positions = await getAlpacaPositions();
            const position = positions.find(p => p.symbol === command.ticker);
            
            if (!position || parseFloat(position.qty) < command.shares) {
              const currentShares = position ? parseFloat(position.qty) : 0;
              log(`❌ Not enough shares of ${command.ticker} to sell. You have ${currentShares} shares.`);
            } else {
              const price = await getStockPrice(command.ticker);
              const orderValue = command.shares * price;

              // Create market sell order through Alpaca
              const order = await alpaca.createOrder({
                symbol: command.ticker,
                qty: command.shares,
                side: 'sell',
                type: 'market',
                time_in_force: 'gtc'
              });

              log(`💸 Submitted sell order for ${command.shares} shares of ${command.ticker} (Order ID: ${order.id})`);
              log(`✅ Sell result: Submitted sell order for ${command.shares} shares of ${command.ticker} at market price. Order ID: ${order.id}. Status: ${order.status}. Estimated proceeds: $${orderValue.toFixed(2)}.`);
            }
          } catch (error) {
            log(`❌ Failed to sell ${command.shares} shares of ${command.ticker}: ${error}`);
          }
          break;
          
        case 'PRICE':
          log(`🛠️ Executing PRICE command: ${command.ticker}`);
          const price = await getStockPrice(command.ticker);
          log(`💰 ${command.ticker} price: $${price}`);
          break;
          
        case 'SEARCH':
          log(`🛠️ Executing SEARCH command: ${command.query}`);
          const searchResult = await webSearch(command.query);
          log(`🔍 Search results: ${searchResult.substring(0, 200)}...`);
          break;
          
        case 'THINK':
          log(`🛠️ Executing THINK command`);
          log(`🧠 Gemini is analyzing market conditions...`);
          break;
      }
    } catch (error) {
      log(`❌ Error executing ${command.type} command: ${error}`);
    }
  }
};

const runNativeGeminiTradingSession = async (): Promise<void> => {
  log("🚀 Starting Native Gemini trading session");

  try {
    const thread = await loadThread();
    const geminiModel = createNativeGeminiClient();
    const systemPrompt = await readFile("system-prompt.md", "utf-8");

    // Convert thread to native Gemini format
    const history = [];

    // Add system prompt if thread is new
    if (thread.length === 0) {
      log("✨ New thread, adding system prompt.");
    }

    // Convert existing thread to Gemini format
    for (const item of thread) {
      if ('role' in item && 'content' in item) {
        if (item.role === "user") {
          history.push({
            role: "user",
            parts: [{ text: typeof item.content === 'string' ? item.content : JSON.stringify(item.content) }]
          });
        } else if (item.role === "assistant") {
          history.push({
            role: "model", 
            parts: [{ text: typeof item.content === 'string' ? item.content : JSON.stringify(item.content) }]
          });
        }
      }
    }

    // Start chat with history
    // Note: Skip system instruction for Gemini due to API format issues
    // The system prompt content will be provided in the user message instead
    const chat = geminiModel.startChat({
      history,
    });

    // Define available tools (same as in agent-gemini.ts)
    const tools = [
      {
        name: "think",
        description: "Think about a trading strategy with step-by-step reasoning",
        parameters: {
          type: "object",
          properties: {
            thought_process: {
              type: "array",
              items: { type: "string" },
              description: "Array of thoughts for step-by-step reasoning"
            }
          },
          required: ["thought_process"]
        }
      },
      {
        name: "get_stock_price",
        description: "Get the current price of a stock ticker",
        parameters: {
          type: "object",
          properties: {
            ticker: {
              type: "string",
              description: "Stock ticker symbol (e.g., AAPL, GOOGL, MSFT)"
            }
          },
          required: ["ticker"]
        }
      },
      {
        name: "get_portfolio",
        description: "Get your current portfolio holdings and trading history",
        parameters: {
          type: "object",
          properties: {},
          required: []
        }
      },
      {
        name: "get_net_worth",
        description: "Get your current net worth (total portfolio value)",
        parameters: {
          type: "object",
          properties: {},
          required: []
        }
      },
      {
        name: "web_search",
        description: "Search the web for information",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query for web search"
            }
          },
          required: ["query"]
        }
      },
      {
        name: "buy",
        description: "Buy a given stock at the current market price using Alpaca paper trading",
        parameters: {
          type: "object",
          properties: {
            ticker: {
              type: "string",
              description: "Stock ticker symbol (e.g., AAPL, GOOGL, MSFT)"
            },
            quantity: {
              type: "number",
              description: "Number of shares to buy (must be positive)"
            }
          },
          required: ["ticker", "quantity"]
        }
      },
      {
        name: "sell",
        description: "Sell a given stock at the current market price using Alpaca paper trading",
        parameters: {
          type: "object",
          properties: {
            ticker: {
              type: "string",
              description: "Stock ticker symbol (e.g., AAPL, GOOGL, MSFT)"
            },
            quantity: {
              type: "number",
              description: "Number of shares to sell (must be positive)"
            }
          },
          required: ["ticker", "quantity"]
        }
      },
      {
        name: "short_sell",
        description: "Short sell a stock by selling shares you don't own, betting the price will decrease. Warning: Short positions have unlimited loss potential.",
        parameters: {
          type: "object",
          properties: {
            ticker: {
              type: "string",
              description: "Stock ticker symbol (e.g., AAPL, GOOGL, MSFT)"
            },
            shares: {
              type: "number",
              description: "Number of shares to short sell (must be positive)"
            }
          },
          required: ["ticker", "shares"]
        }
      },
      {
        name: "cover_short",
        description: "Cover (close) a short position by buying back shares to close the short sale",
        parameters: {
          type: "object",
          properties: {
            ticker: {
              type: "string",
              description: "Stock ticker symbol (e.g., AAPL, GOOGL, MSFT)"
            },
            shares: {
              type: "number",
              description: "Number of shares to cover (must be positive)"
            }
          },
          required: ["ticker", "shares"]
        }
      }
    ];

    const currentPrompt = `${systemPrompt}

It's ${new Date().toLocaleString("en-US")}. Time for your trading analysis! Review your portfolio, scan the markets for opportunities, and make strategic trades to grow your initial $1,000 investment. Good luck! 📈`;

    log(`🔄 Sending message to Gemini with tools`);
    
    // Add delay to prevent rate limiting
    await sleep(2000);
    
    try {
      log(`🔍 DEBUG: Sending prompt length: ${currentPrompt.length} chars`);
      log(`🔍 DEBUG: Tools configured: ${tools.length} tools`);
      log(`🔍 DEBUG: Tool names: ${tools.map(t => t.name).join(', ')}`);
      
      // Send message with function calling enabled (like GPT-4o)
      const result = await chat.sendMessage(currentPrompt, {
        tools: [{
          functionDeclarations: tools
        }]
      });
      
      log(`🔍 DEBUG: Got response from Gemini`);
      const response = result.response;
      log(`🔍 DEBUG: Response object exists: ${!!response}`);
      
      const text = response.text();
      log(`🔍 DEBUG: Response text length: ${text ? text.length : 'null'} chars`);
      log(`🔍 DEBUG: Response text preview: ${text ? text.substring(0, 200) + '...' : 'EMPTY'}`);
      
      // Check if function calls were made
      log(`🔍 DEBUG: Checking for function calls...`);
      log(`🔍 DEBUG: response.functionCalls exists: ${!!response.functionCalls}`);
      
      if (response.functionCalls && response.functionCalls()) {
        const functionCalls = response.functionCalls();
        log(`🔍 DEBUG: Function calls found: ${functionCalls.length}`);
        log(`🔧 Processing ${functionCalls.length} function calls`);
        
        let functionResults = [];
        
        for (const functionCall of functionCalls) {
          const { name, args } = functionCall;
          log(`🛠️ Executing function: ${name}`);
          
          let functionResult: string;
          
          try {
            switch (name) {
              case "think":
                const thoughts = args.thought_process || [];
                thoughts.forEach((thought: string) => log(`🧠 ${thought}`));
                functionResult = `Completed thinking with ${thoughts.length} steps of reasoning.`;
                break;
              case "get_stock_price":
                const ticker = args.ticker;
                const price = await getStockPrice(ticker);
                log(`🔖 Searched for stock price for ${ticker}: $${price}`);
                functionResult = price.toString();
                break;
              case "get_portfolio":
                const portfolio = await getPortfolio();
                log(`💹 Fetched portfolio: $${portfolio.cash}`);
                functionResult = `Your cash balance is $${portfolio.cash}.
Current holdings:
${Object.entries(portfolio.holdings)
  .map(([ticker, shares]) => `  - ${ticker}: ${shares} shares`)
  .join("\n")}

Trade history:
${portfolio.history
  .map(
    (trade) =>
      `  - ${trade.date} ${trade.type} ${trade.ticker} ${trade.shares} shares at $${trade.price} per share, for a total of $${trade.total}`
  )
  .join("\n")}`;
                break;
              case "get_net_worth":
                const netWorth = await calculateNetWorth();
                const portfolioForReturn = await getPortfolio();
                const annualizedReturn = await calculateAnnualizedReturn(portfolioForReturn);
                log(`💰 Current net worth: $${netWorth} (${annualizedReturn}% annualized return)`);
                functionResult = `Your current net worth is $${netWorth}
- Cash: $${portfolioForReturn.cash}
- Holdings value: $${(netWorth - portfolioForReturn.cash).toFixed(2)}
- Annualized return: ${annualizedReturn}% (started with $1,000)
- ${netWorth >= 1000 ? "📈 Up" : "📉 Down"} $${Math.abs(netWorth - 1000).toFixed(2)} from initial investment`;
                break;
              case "web_search":
                const query = args.query;
                log(`🔍 Searching the web for: ${query}`);
                functionResult = await webSearch(query);
                break;
              case "buy":
                try {
                  const { ticker, shares, quantity } = args;
                  const buyShares = quantity || shares; // Support both parameter names
                  const account = await getAlpacaAccount();
                  const price = await getStockPrice(ticker);
                  const orderValue = buyShares * price;

                  // Check if we have enough buying power
                  if (parseFloat(account.buying_power) < orderValue) {
                    functionResult = `You don't have enough buying power to buy ${buyShares} shares of ${ticker}. Your buying power is $${account.buying_power} and the estimated cost is $${orderValue.toFixed(2)}.`;
                  } else {
                    // Create market buy order through Alpaca
                    const order = await alpaca.createOrder({
                      symbol: ticker,
                      qty: buyShares,
                      side: 'buy',
                      type: 'market',
                      time_in_force: 'gtc'
                    });

                    log(`💰 Submitted buy order for ${buyShares} shares of ${ticker} (Order ID: ${order.id})`);
                    functionResult = `Submitted buy order for ${buyShares} shares of ${ticker} at market price. Order ID: ${order.id}. Status: ${order.status}. Estimated cost: $${orderValue.toFixed(2)}.`;
                  }
                } catch (error) {
                  const { ticker, shares, quantity } = args;
                  const buyShares = quantity || shares;
                  log(`❌ Failed to buy ${buyShares} shares of ${ticker}: ${error}`);
                  functionResult = `Failed to place buy order for ${buyShares} shares of ${ticker}. Error: ${error}`;
                }
                break;
              case "sell":
                try {
                  const { ticker, shares, quantity } = args;
                  const sellShares = quantity || shares; // Support both parameter names
                  const positions = await getAlpacaPositions();
                  const position = positions.find(p => p.symbol === ticker);
                  
                  if (!position || parseFloat(position.qty) < sellShares) {
                    const currentShares = position ? parseFloat(position.qty) : 0;
                    functionResult = `You don't have enough shares of ${ticker} to sell. You have ${currentShares} shares.`;
                  } else {
                    const price = await getStockPrice(ticker);
                    const orderValue = sellShares * price;

                    // Create market sell order through Alpaca
                    const order = await alpaca.createOrder({
                      symbol: ticker,
                      qty: sellShares,
                      side: 'sell',
                      type: 'market',
                      time_in_force: 'gtc'
                    });

                    log(`💸 Submitted sell order for ${sellShares} shares of ${ticker} (Order ID: ${order.id})`);
                    functionResult = `Submitted sell order for ${sellShares} shares of ${ticker} at market price. Order ID: ${order.id}. Status: ${order.status}. Estimated proceeds: $${orderValue.toFixed(2)}.`;
                  }
                } catch (error) {
                  const { ticker, shares, quantity } = args;
                  const sellShares = quantity || shares;
                  log(`❌ Failed to sell ${sellShares} shares of ${ticker}: ${error}`);
                  functionResult = `Failed to place sell order for ${sellShares} shares of ${ticker}. Error: ${error}`;
                }
                break;
              case "short_sell":
                try {
                  const { ticker, shares } = args;
                  // Check account equity for short selling requirements
                  const account = await getAlpacaAccount();
                  const accountEquity = parseFloat(account.portfolio_value);
                  const buyingPower = parseFloat(account.buying_power);
                  
                  // Alpaca requires $40,000 minimum account equity for short selling
                  if (accountEquity < 40000) {
                    functionResult = `Account equity of $${accountEquity.toFixed(2)} is below the $40,000 minimum required for short selling on Alpaca.`;
                  } else {
                    const price = await getStockPrice(ticker);
                    const orderValue = shares * price;
                    
                    // Basic check - ensure sufficient buying power for short position
                    if (buyingPower < orderValue * 0.5) { // 50% margin requirement approximation
                      functionResult = `Insufficient buying power for short position. Need ~$${(orderValue * 0.5).toFixed(2)} but have $${buyingPower.toFixed(2)} buying power.`;
                    } else {
                      // Create market sell order (short sell) through Alpaca
                      const order = await alpaca.createOrder({
                        symbol: ticker,
                        qty: shares,
                        side: 'sell',
                        type: 'market',
                        time_in_force: 'gtc'
                      });

                      log(`📉 Submitted SHORT SELL order for ${shares} shares of ${ticker} (Order ID: ${order.id})`);
                      functionResult = `Submitted SHORT SELL order for ${shares} shares of ${ticker} at market price. Order ID: ${order.id}. Status: ${order.status}. Estimated proceeds: $${orderValue.toFixed(2)}. WARNING: This is a short position with unlimited loss potential.`;
                    }
                  }
                } catch (error) {
                  log(`❌ Failed to short sell ${args.shares} shares of ${args.ticker}: ${error}`);
                  functionResult = `Failed to place short sell order for ${args.shares} shares of ${args.ticker}. Error: ${error}`;
                }
                break;
              case "cover_short":
                try {
                  const { ticker, shares } = args;
                  const positions = await getAlpacaPositions();
                  const position = positions.find(p => p.symbol === ticker);
                  
                  // Check if we have a short position (negative quantity)
                  if (!position || parseFloat(position.qty) >= 0) {
                    const currentShares = position ? parseFloat(position.qty) : 0;
                    functionResult = `No short position found for ${ticker}. Current position: ${currentShares} shares (positive = long, negative = short).`;
                  } else {
                    const shortPosition = Math.abs(parseFloat(position.qty));
                    if (shares > shortPosition) {
                      functionResult = `Cannot cover ${shares} shares - you only have ${shortPosition} shares short in ${ticker}.`;
                    } else {
                      const price = await getStockPrice(ticker);
                      const orderValue = shares * price;

                      // Create market buy order to cover short position
                      const order = await alpaca.createOrder({
                        symbol: ticker,
                        qty: shares,
                        side: 'buy',
                        type: 'market',
                        time_in_force: 'gtc'
                      });

                      log(`📈 Submitted BUY TO COVER order for ${shares} shares of ${ticker} (Order ID: ${order.id})`);
                      functionResult = `Submitted BUY TO COVER order for ${shares} shares of ${ticker} at market price. Order ID: ${order.id}. Status: ${order.status}. Estimated cost: $${orderValue.toFixed(2)}.`;
                    }
                  }
                } catch (error) {
                  log(`❌ Failed to cover short position for ${args.shares} shares of ${args.ticker}: ${error}`);
                  functionResult = `Failed to place cover order for ${args.shares} shares of ${args.ticker}. Error: ${error}`;
                }
                break;
              default:
                functionResult = `Unknown function: ${name}`;
            }
          } catch (error) {
            log(`❌ Error executing function ${name}: ${error}`);
            functionResult = `Error executing ${name}: ${error}`;
          }

          functionResults.push({
            name,
            response: functionResult
          });
        }
        
        // Send function results back to continue conversation
        const followUpResult = await chat.sendMessage(functionResults);
        const followUpResponse = followUpResult.response;
        const finalText = followUpResponse.text();
        
        if (finalText) {
          log(`🤖 Gemini final response: ${finalText}`);
        }
        
        log(`✅ Native Gemini trading session completed with tools: ${finalText}`);
        
        // Save conversation including function calls
        const newThread = [
          ...thread,
          { role: "user", content: currentPrompt },
          { role: "assistant", content: `${text || 'Function calls made'} -> ${finalText}` }
        ];
        
        await saveThread(newThread);
        
      } else {
        // No function calls, try parsing text response as fallback
        if (text) {
          log(`🤖 Gemini text response: ${text}`);
          
          // Try to parse JSON tool calls from text
          const toolCallResults = await parseTextForToolCalls(text);
          if (toolCallResults.length > 0) {
            log(`🔧 Processing ${toolCallResults.length} parsed tool calls`);
            
            // Process parsed tool calls
            const functionResults = [];
            for (const toolCall of toolCallResults) {
              const functionResult = await executeToolCall(toolCall.name, toolCall.args);
              functionResults.push({
                name: toolCall.name,
                response: functionResult
              });
            }
            
            // Send function results back to continue conversation
            const followUpResult = await chat.sendMessage(functionResults.map(r => `${r.name}: ${r.response}`).join('\n\n'));
            const followUpResponse = followUpResult.response;
            const finalText = followUpResponse.text();
            
            if (finalText) {
              log(`🤖 Gemini final response: ${finalText}`);
              
              // Parse and execute any additional tool calls in the final response
              const finalToolCalls = await parseTextForToolCalls(finalText);
              if (finalToolCalls.length > 0) {
                log(`🔧 Processing ${finalToolCalls.length} additional tool calls from final response`);
                
                // Execute final tool calls
                for (const toolCall of finalToolCalls) {
                  const functionResult = await executeToolCall(toolCall.name, toolCall.args);
                  log(`✅ Final tool result: ${functionResult}`);
                }
              }
            }
            
            log(`✅ Native Gemini trading session completed with parsed tools: ${finalText}`);
          } else {
            // Legacy command parsing disabled - using proper JSON tool calls instead
            // await parseAndExecuteCommands(text);
            log(`✅ Native Gemini trading session completed: ${text}`);
          }
        }
        
        log(`✅ Native Gemini trading session completed: ${text}`);
        
        // Save simple conversation to thread
        const newThread = [
          ...thread,
          { role: "user", content: currentPrompt },
          { role: "assistant", content: text }
        ];
        
        await saveThread(newThread);
      }
      
    } catch (error) {
      log(`❌ Error in Gemini chat: ${error}`);
      
      // Fallback response
      const fallbackResponse = "Gemini trading session encountered an error but completed successfully.";
      log(`✅ Native Gemini trading session completed (with fallback): ${fallbackResponse}`);
      
      // Save fallback thread
      const fallbackThread = [
        ...thread,
        { role: "user", content: currentPrompt },
        { role: "assistant", content: fallbackResponse }
      ];
      
      await saveThread(fallbackThread);
    }
    
    await updateReadme();
    await generateCSVReport();
      
  } catch (error) {
    log(`❌ Native Gemini trading session failed: ${error}`);
    throw error;
  }
};

// Original OpenAI agent runner using the Agents SDK
const runOpenAITradingSession = async (): Promise<void> => {
  log("🚀 Starting OpenAI trading session");
  
  if (!agent) {
    throw new Error('OpenAI Agent not initialized');
  }
  
  try {
    const thread = await loadThread();
    const result = await withRetry(async () => {
      return await run(
        agent,
        thread.concat({
          role: "user",
          content: `It's ${new Date().toLocaleString(
            "en-US"
          )}. Time for your trading analysis! Review your portfolio, scan the markets for opportunities, and make strategic trades to grow your initial $1,000 investment. Good luck! 📈`,
        }),
        { maxTurns: 100 }
      );
    });
    
    log(`✅ OpenAI trading session completed: ${result.finalOutput}`);
    
    await saveThread(result.history);
    await updateReadme();
    await generateCSVReport();
    
  } catch (error) {
    log(`❌ OpenAI trading session failed: ${error}`);
    throw error;
  }
};

// Log cache statistics for the session
const logCacheStats = () => {
  if (modelName.includes('gemini')) {
    log(`📊 Gemini cache stats - Explicit cache hits: ${sessionCacheStats.geminiCacheHits}, Total requests: ${sessionCacheStats.totalRequests}`);
    if (sessionCacheStats.geminiCacheHits > 0) {
      const hitRate = ((sessionCacheStats.geminiCacheHits / sessionCacheStats.totalRequests) * 100).toFixed(1);
      log(`💰 Gemini cache hit rate: ${hitRate}% (estimated 75% cost savings on cached tokens)`);
    }
  } else {
    log(`📊 OpenAI automatic caching active - Check response logs for cached_tokens information`);
    if (sessionCacheStats.openaiCachedTokens > 0) {
      log(`💰 OpenAI cached tokens this session: ${sessionCacheStats.openaiCachedTokens} (50% cost savings)`);
    }
  }
  
  // Reset stats for next session
  sessionCacheStats = {
    openaiCachedTokens: 0,
    geminiCacheHits: 0,
    totalRequests: 0
  };
};

// Run OpenAI trading session
const runTradingSession = async (): Promise<void> => {
  if (isKillSwitchActive()) {
    log(`🛑 KILL switch active — skipping session.`);
    return;
  }

  // Refresh state and check circuit breaker before letting the LLM near tools.
  try {
    const account = await broker.getAccount();
    const portfolioValue = account.portfolioValue;
    let state = recomputeIfNewDay(portfolioValue);
    guardrailConfig = loadGuardrailConfig();
    if (shouldTripCircuitBreaker(state, guardrailConfig)) {
      if (!state.circuitBreakerTripped) {
        markCircuitBreakerTripped();
      }
      log(`🛑 Daily loss circuit breaker tripped — skipping session. Portfolio $${portfolioValue.toFixed(2)} vs start of day $${state.startOfDayValue.toFixed(2)}.`);
      return;
    }
    if (state.tradesToday >= guardrailConfig.dailyTradeCountLimit) {
      log(`🛑 Daily trade count (${state.tradesToday}/${guardrailConfig.dailyTradeCountLimit}) reached — skipping session.`);
      return;
    }
  } catch (err) {
    log(`⚠️  Pre-session state check failed: ${err}. Continuing cautiously.`);
  }

  await runOpenAITradingSession();

  // Log cache statistics after session
  logCacheStats();
};

const runContinuous = async (): Promise<void> => {
  log(`🔄 Starting continuous trading mode (every ${intervalMinutes} minutes during market hours)`);
  log("📝 Press Ctrl+C to stop");
  
  let sessionCount = 0;
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    log("🛑 Received shutdown signal. Completing current session...");
    process.exit(0);
  });
  
  while (true) {
    if (isKillSwitchActive()) {
      log(`🛑 KILL switch detected. Stopping continuous mode.`);
      process.exit(0);
    }

    const marketOpen = isMarketOpen();

    if (!marketOpen) {
      const nextOpen = getNextMarketOpen();
      const hoursUntilOpen = Math.ceil((nextOpen.getTime() - Date.now()) / (1000 * 60 * 60));
      
      log(`🕐 Markets are closed. Next session when markets open: ${nextOpen.toLocaleString()}`);
      log(`💤 Sleeping for ${hoursUntilOpen} hours until market opens...`);
      
      // Sleep until market opens
      const sleepTime = nextOpen.getTime() - Date.now();
      await sleep(Math.max(sleepTime, 60000)); // At least 1 minute
      continue;
    }
    
    sessionCount++;
    
    try {
      log(`📈 Starting trading session #${sessionCount} (Markets Open)`);
      await runTradingSession();
      
      if (sessionCount === 1) {
        log(`✅ First session completed successfully`);
      }
      
      // Check if markets will still be open after the interval
      const nextRunTime = new Date(Date.now() + intervalMinutes * 60 * 1000);
      const nextMarketOpen = isMarketOpen();
      
      if (nextMarketOpen) {
        log(`⏰ Next trading session in ${intervalMinutes} minutes at ${nextRunTime.toLocaleString()}`);
        await sleep(intervalMinutes * 60 * 1000);
      } else {
        // Markets will be closed by next interval, wait until they reopen
        const nextOpen = getNextMarketOpen();
        log(`🕐 Markets closing soon. Next session when markets reopen: ${nextOpen.toLocaleString()}`);
        const sleepTime = nextOpen.getTime() - Date.now();
        await sleep(Math.max(sleepTime, 60000));
      }
      
    } catch (error) {
      log(`❌ Session #${sessionCount} failed: ${error}`);
      
      if (isMarketOpen()) {
        log(`⏰ Retrying in ${intervalMinutes} minutes...`);
        await sleep(intervalMinutes * 60 * 1000);
      } else {
        const nextOpen = getNextMarketOpen();
        log(`🕐 Markets closed. Retrying when markets reopen: ${nextOpen.toLocaleString()}`);
        const sleepTime = nextOpen.getTime() - Date.now();
        await sleep(Math.max(sleepTime, 60000));
      }
    }
  }
};

// Validate all API credentials at startup (regardless of market status or mode)
await validateAllCredentials();

// Main execution logic
if (continuousMode) {
  log("🔄 Continuous mode enabled");
  await runContinuous();
} else {
  log("🎯 Single session mode");
  const marketOpen = isMarketOpen();
  if (marketOpen) {
    log("📈 Markets are currently OPEN");
  } else {
    log("🕐 Markets are currently CLOSED");
    const nextOpen = getNextMarketOpen();
    log(`💡 Next market open: ${nextOpen.toLocaleString()}`);
  }
  await runTradingSession();
}
