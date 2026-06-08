/**
 * Wonder — on-chain constants for Monad mainnet + LFJ Liquidity Book (DLMM).
 * All addresses verified June 2026 (Monad docs + LFJ developer docs + MonadScan).
 */

// ─── Monad mainnet ────────────────────────────────────────────────────
export const CHAIN_ID = 143;
export const NETWORK_NAME = "monad";
export const NATIVE_SYMBOL = "MON";

export const DEFAULT_RPC_URLS = [
  "https://rpc.monad.xyz", // QuickNode  ~25 rps
  "https://rpc2.monad.xyz", // Goldsky   300/10s
  "https://rpc3.monad.xyz", // Ankr      300/10s
];

export const EXPLORER_URL = "https://monadscan.com";
export const explorerAddr = (addr: string) => `${EXPLORER_URL}/address/${addr}`;
export const explorerToken = (addr: string) => `${EXPLORER_URL}/token/${addr}`;

// ─── LFJ (formerly Trader Joe) — Liquidity Book on Monad ──────────────
// v2.2 = the live DLMM (bin-based Liquidity Book), source-verified on MonadScan.
export const LB_FACTORY = "0xb43120c4745967fa9b93E79C149E66B0f2D6Fe0c"; // LBFactory v2.2
export const LB_ROUTER = "0x18556DA13313f3532c54711497A8FedAC273220E"; // LBRouter v2.2
export const LB_FACTORY_V1 = "0xe32D45C2B1c17a0fE0De76f1ebFA7c44B7810034"; // legacy v1
export const JOE_TOKEN = "0x371c7ec6D8039ff7933a2AA28EB827Ffe1F52f07";

// ─── Common tokens (Monad) ───────────────────────────────────────────
export const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A"; // Wrapped MON
// NOTE: canonical USDC/USDT on Monad are resolved dynamically from pair quote
// tokens (DexScreener) rather than hard-coded — left out until verified.

// ─── Liquidity Book math ─────────────────────────────────────────────
// Bin ids are centered on 2^23. price(id) = (1 + binStep/1e4)^(id - 2^23).
export const LB_ACTIVE_ID_OFFSET = 8_388_608; // 2^23
// Base swap fee fraction = baseFactor * binStep * 1e10 / 1e18 = baseFactor*binStep/1e8.
export const LB_BASE_FEE_DENOMINATOR = 1e8;

// ─── External data APIs ──────────────────────────────────────────────
export const DEXSCREENER_API = "https://api.dexscreener.com";
export const DEXSCREENER_CHAIN = "monad"; // DexScreener chainId slug for Monad
export const DEXSCREENER_DEX_ID = "traderjoe"; // LFJ pools surface under "traderjoe"
export const DEXSCREENER_MAX_PAIRS_PER_CALL = 30;

export const GOPLUS_API = "https://api.gopluslabs.io/api/v1";
