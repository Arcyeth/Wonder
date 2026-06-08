/**
 * Wonder config — loads .env + user-config.json into a single `config` object.
 *
 * Screening thresholds are deliberately calibrated LOOSE for Monad's early
 * LFJ ecosystem (total LFJ TVL ~$3.4M as of mid-2026), unlike Meridian's
 * Solana/Meteora defaults (minTvl $10k, minHolders 500) which would filter
 * out essentially every Monad pool. Tune via user-config.json.
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

  log: {
    level: process.env.LOG_LEVEL || u.logLevel || "info",
  },
};

export type WonderConfig = typeof config;
export { REPO_ROOT };
