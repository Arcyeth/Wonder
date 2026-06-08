/**
 * DexScreener client — metrics for Monad pairs (TVL/volume/mcap/price).
 * LFJ pools surface under dexId "traderjoe" on chain "monad".
 *
 * Endpoint: GET /latest/dex/pairs/{chainId}/{comma-separated pairAddresses}
 * (max 30 addresses per call).
 */
import {
  DEXSCREENER_API,
  DEXSCREENER_CHAIN,
  DEXSCREENER_MAX_PAIRS_PER_CALL,
} from "../constants";
import { numeric, chunk, pMap } from "../util/num";
import { log } from "../util/log";
import type { DexPair } from "../types";

function n(v: unknown): number | null {
  return numeric(v);
}

function parsePair(raw: any): DexPair {
  return {
    pairAddress: String(raw.pairAddress || ""),
    dexId: String(raw.dexId || ""),
    labels: Array.isArray(raw.labels) ? raw.labels.map(String) : [],
    baseToken: {
      address: String(raw.baseToken?.address || ""),
      name: String(raw.baseToken?.name || ""),
      symbol: String(raw.baseToken?.symbol || ""),
    },
    quoteToken: {
      address: String(raw.quoteToken?.address || ""),
      name: String(raw.quoteToken?.name || ""),
      symbol: String(raw.quoteToken?.symbol || ""),
    },
    priceUsd: n(raw.priceUsd),
    priceNative: n(raw.priceNative),
    liquidityUsd: n(raw.liquidity?.usd),
    volume: {
      h24: n(raw.volume?.h24) ?? 0,
      h6: n(raw.volume?.h6) ?? 0,
      h1: n(raw.volume?.h1) ?? 0,
      m5: n(raw.volume?.m5) ?? 0,
    },
    txns: {
      h24: { buys: n(raw.txns?.h24?.buys) ?? 0, sells: n(raw.txns?.h24?.sells) ?? 0 },
      h6: { buys: n(raw.txns?.h6?.buys) ?? 0, sells: n(raw.txns?.h6?.sells) ?? 0 },
      h1: { buys: n(raw.txns?.h1?.buys) ?? 0, sells: n(raw.txns?.h1?.sells) ?? 0 },
      m5: { buys: n(raw.txns?.m5?.buys) ?? 0, sells: n(raw.txns?.m5?.sells) ?? 0 },
    },
    priceChange: {
      h24: n(raw.priceChange?.h24) ?? 0,
      h6: n(raw.priceChange?.h6) ?? 0,
      h1: n(raw.priceChange?.h1) ?? 0,
      m5: n(raw.priceChange?.m5) ?? 0,
    },
    fdv: n(raw.fdv),
    marketCap: n(raw.marketCap),
    pairCreatedAt: n(raw.pairCreatedAt),
  };
}

async function fetchChunk(addresses: string[]): Promise<DexPair[]> {
  const url = `${DEXSCREENER_API}/latest/dex/pairs/${DEXSCREENER_CHAIN}/${addresses.join(",")}`;
  const res = await fetch(url);
  if (!res.ok) {
    log.warn("dexscreener", `pairs ${res.status} for ${addresses.length} addr(s)`);
    return [];
  }
  const data: any = await res.json();
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  return pairs.map(parsePair);
}

/** Returns a map keyed by lowercased pairAddress. Pairs with no data are absent. */
export async function getPairsByAddresses(
  addresses: string[],
): Promise<Map<string, DexPair>> {
  const map = new Map<string, DexPair>();
  if (addresses.length === 0) return map;
  const chunks = chunk(addresses, DEXSCREENER_MAX_PAIRS_PER_CALL);
  const results = await pMap(chunks, fetchChunk, 4);
  for (const list of results) {
    for (const p of list) {
      if (p.pairAddress) map.set(p.pairAddress.toLowerCase(), p);
    }
  }
  log.info("dexscreener", `metrics for ${map.size}/${addresses.length} pair(s)`);
  return map;
}

/** Fetch a single pair by address (used by pool-detail). */
export async function getPair(pairAddress: string): Promise<DexPair | null> {
  const map = await getPairsByAddresses([pairAddress]);
  return map.get(pairAddress.toLowerCase()) ?? null;
}
