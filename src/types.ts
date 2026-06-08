/** Shared types for Wonder. */

/** LB liquidity distribution shapes. */
export type Strategy = "spot" | "curve" | "bid_ask";

/** On-chain reads from a single LFJ LBPair (Liquidity Book) contract. */
export interface LbPairOnchain {
  pair: string; // LBPair address
  tokenX: string;
  tokenY: string;
  symbolX: string;
  symbolY: string;
  decimalsX: number;
  decimalsY: number;
  binStep: number; // basis points
  activeId: number;
  reserveX: bigint;
  reserveY: bigint;
  baseFeePct: number; // base swap fee as a percentage (e.g. 0.25 = 0.25%)
  /** Human price of 1 tokenX denominated in tokenY (from active bin id). */
  priceXinY: number;
}

/** Condensed DexScreener pair metrics. */
export interface DexPair {
  pairAddress: string;
  dexId: string;
  labels: string[];
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd: number | null;
  priceNative: number | null;
  liquidityUsd: number | null;
  volume: { h24: number; h6: number; h1: number; m5: number };
  txns: {
    h24: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    m5: { buys: number; sells: number };
  };
  priceChange: { h24: number; h6: number; h1: number; m5: number };
  fdv: number | null;
  marketCap: number | null;
  pairCreatedAt: number | null; // ms epoch
}

/** GoPlus token-security summary (the fields Wonder screens on). */
export interface TokenSecurity {
  address: string;
  holderCount: number | null;
  isHoneypot: boolean | null;
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  isOpenSource: boolean | null;
  isProxy: boolean | null;
  canTakeBackOwnership: boolean | null;
  hiddenOwner: boolean | null;
  isMintable: boolean | null;
  ownerAddress: string | null;
  creatorAddress: string | null;
  lpHolderCount: number | null;
  top10HolderPct: number | null; // sum of top-10 non-LP holder percentages
  raw?: Record<string, unknown>;
}

/** A fully-enriched screening candidate (the unit the agent/CLI consumes). */
export interface Candidate {
  pool: string; // LBPair address
  name: string; // "BASE-QUOTE"
  base: { symbol: string; address: string };
  quote: { symbol: string; address: string };
  binStep: number | null;
  feePct: number | null; // base fee %
  activeId: number | null;
  priceUsd: number | null;
  priceXinY: number | null;

  // core metrics
  tvlUsd: number | null; // DexScreener liquidity.usd
  volumeWindow: number | null; // volume in selected timeframe
  feeWindow: number | null; // estimated fees in window = volume * feeFraction
  feeTvlRatio: number | null; // feeWindow / tvl  (the key yield signal)
  timeframe: string;

  // token health
  holders: number | null;
  mcap: number | null;
  fdv: number | null;
  ageHours: number | null;
  organicProxy: number; // 0-100 synthesized "organic" score (no Jupiter equivalent on Monad)

  // activity
  buys: number;
  sells: number;
  buySellRatio: number | null;
  priceChangePct: number | null;

  // security (GoPlus)
  security: TokenSecurity | null;

  // scoring
  score: number;
}

export interface FilteredReason {
  name: string;
  reason: string;
}

export interface ScreenResult {
  candidates: Candidate[];
  totalScreened: number;
  filteredExamples: FilteredReason[];
}
