/**
 * Wonder config — loads .env + user-config.json into a single `config` object.
 *
 * Screening thresholds are deliberately calibrated LOOSE for Monad's early
 * LFJ ecosystem (total LFJ TVL ~$3.4M as of mid-2026); aggressive defaults
 * would filter out essentially every Monad pool. Tune via user-config.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { DEFAULT_RPC_URLS } from "./constants";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const USER_CONFIG_PATH = path.join(REPO_ROOT, "user-config.json");

const u: Record<string, any> = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};

/** DexScreener volume/priceChange windows. */
export type Timeframe = "m5" | "h1" | "h6" | "h24";
const VALID_TIMEFRAMES: Timeframe[] = ["m5", "h1", "h6", "h24"];
function normTimeframe(tf: unknown): Timeframe {
  const v = String(tf || "h24") as Timeframe;
  return VALID_TIMEFRAMES.includes(v) ? v : "h24";
}

export const config = {
  chain: {
    rpcUrl: process.env.RPC_URL || u.rpcUrl || DEFAULT_RPC_URLS[0],
  },

  goplus: {
    chainId: process.env.GOPLUS_CHAIN_ID || u.goplusChainId || "143",
    appKey: process.env.GOPLUS_APP_KEY || "",
    appSecret: process.env.GOPLUS_APP_SECRET || "",
    enabled: u.goplusEnabled ?? true,
  },

  // ─── Pool screening thresholds (calibrated for Monad/LFJ) ──────────
  screening: {
    timeframe: normTimeframe(u.timeframe), // window for volume/feeTvl/priceChange
    minTvl: u.minTvl ?? 2_000, // DexScreener liquidity.usd floor
    maxTvl: u.maxTvl ?? null,
    minVolume: u.minVolume ?? 500, // volume in selected window (USD)
    minFeeTvlRatio: u.minFeeTvlRatio ?? 0.0, // est. fees/TVL in window; 0 = off by default
    minHolders: u.minHolders ?? 30,
    minMcap: u.minMcap ?? 10_000,
    maxMcap: u.maxMcap ?? 100_000_000,
    minBinStep: u.minBinStep ?? 1,
    maxBinStep: u.maxBinStep ?? 300,
    minOrganicProxy: u.minOrganicProxy ?? 0, // 0-100; synthesized signal, off by default
    // security gates (GoPlus)
    rejectHoneypot: u.rejectHoneypot ?? true,
    maxBuyTaxPct: u.maxBuyTaxPct ?? 10,
    maxSellTaxPct: u.maxSellTaxPct ?? 10,
    maxTop10Pct: u.maxTop10Pct ?? 90,
    requireOpenSource: u.requireOpenSource ?? false,
    minAgeHours: u.minAgeHours ?? null,
    maxAgeHours: u.maxAgeHours ?? null,
    // discovery
    maxPairsToEnrich: u.maxPairsToEnrich ?? 60, // cap on-chain+GoPlus reads per run
  },

  // ─── Wallet / execution (Phase 2) ─────────────────────────────────
  wallet: {
    privateKey: process.env.WALLET_PRIVATE_KEY || "",
    // DRY_RUN default TRUE: build + validate txs but never broadcast.
    dryRun: (process.env.DRY_RUN ?? String(u.dryRun ?? true)).toLowerCase() !== "false",
  },

  // ─── Position management (Phase 2) ────────────────────────────────
  management: {
    strategy: (u.strategy ?? "spot") as "spot" | "curve" | "bid_ask",
    binsBelow: u.binsBelow ?? 10, // bins of tokenY below the active bin
    binsAbove: u.binsAbove ?? 10, // bins of tokenX above the active bin
    idSlippage: u.idSlippage ?? 5, // max active-id drift tolerated on add
    amountSlippagePct: u.amountSlippagePct ?? 1, // amountXMin/YMin tolerance
    deadlineSec: u.deadlineSec ?? 300, // tx deadline window
    gasReserveMon: u.gasReserveMon ?? 0.5, // native MON kept for gas
    deployAmountX: u.deployAmountX ?? 0, // default amount of tokenX to deploy (human units)
    deployAmountY: u.deployAmountY ?? 0, // default amount of tokenY to deploy (human units)
    // exit rules (manage cycle)
    stopLossPct: u.stopLossPct ?? -25, // close if pnl% <= this
    takeProfitPct: u.takeProfitPct ?? 10, // close if pnl% >= this
    closeOnOutOfRange: u.closeOnOutOfRange ?? false, // close when active bin leaves the range
    minClaimUsd: u.minClaimUsd ?? 1, // (informational) min unclaimed fees worth acting on
    maxPositions: u.maxPositions ?? 3, // screen cycle won't open beyond this
  },

  // ─── Scheduler (Phase 4) ──────────────────────────────────────────
  schedule: {
    managementIntervalMin: u.managementIntervalMin ?? 10,
    screeningIntervalMin: u.screeningIntervalMin ?? 30,
    autoDeploy: u.autoDeploy ?? false, // daemon auto-opens the top pick each screen
    evolveEveryCloses: u.evolveEveryCloses ?? 5, // re-tune thresholds every N closes
  },

  // ─── LLM brain (Phase 3b) — provider-agnostic OpenAI-compatible ───
  llm: {
    baseUrl: process.env.LLM_BASE_URL || u.llmBaseUrl || "https://openrouter.ai/api/v1",
    apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || u.llmApiKey || "",
    model: process.env.LLM_MODEL || u.llmModel || "openai/gpt-4o-mini",
    temperature: u.llmTemperature ?? 0.3,
    maxTokens: u.llmMaxTokens ?? 2048,
    maxSteps: u.llmMaxSteps ?? 12,
  },

  log: {
    level: process.env.LOG_LEVEL || u.logLevel || "info",
  },
};

export type WonderConfig = typeof config;
export { REPO_ROOT };
