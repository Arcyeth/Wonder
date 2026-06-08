/**
 * GoPlus token-security client (honeypot / holders / tax / concentration).
 * GoPlus supports Monad; chain_id is configurable (mainnet 143, testnet 10143).
 *
 * Endpoint: GET /token_security/{chain_id}?contract_addresses={a,b,...}
 * Returns a map keyed by lowercased token address. Gracefully degrades to null
 * if GoPlus has not indexed the chain/token.
 */
import { GOPLUS_API } from "../constants";
import { config } from "../config";
import { numeric, chunk, pMap } from "../util/num";
import { log } from "../util/log";
import type { TokenSecurity } from "../types";

function flag(v: unknown): boolean | null {
  if (v === "1" || v === 1 || v === true) return true;
  if (v === "0" || v === 0 || v === false) return false;
  return null;
}

function pctNum(v: unknown): number | null {
  const x = numeric(v);
  return x == null ? null : x * 100; // GoPlus tax/percent fields are fractions
}

function parseSecurity(address: string, r: any): TokenSecurity {
  // Top-10 holder concentration (approx) from the holders array.
  let top10HolderPct: number | null = null;
  if (Array.isArray(r?.holders)) {
    const top10 = r.holders
      .map((h: any) => numeric(h?.percent))
      .filter((x: number | null): x is number => x != null)
      .sort((a: number, b: number) => b - a)
      .slice(0, 10)
      .reduce((s: number, x: number) => s + x, 0);
    top10HolderPct = top10 * 100;
  }

  return {
    address,
    holderCount: numeric(r?.holder_count),
    isHoneypot: flag(r?.is_honeypot),
    buyTaxPct: pctNum(r?.buy_tax),
    sellTaxPct: pctNum(r?.sell_tax),
    isOpenSource: flag(r?.is_open_source),
    isProxy: flag(r?.is_proxy),
    canTakeBackOwnership: flag(r?.can_take_back_ownership),
    hiddenOwner: flag(r?.hidden_owner),
    isMintable: flag(r?.is_mintable),
    ownerAddress: r?.owner_address ?? null,
    creatorAddress: r?.creator_address ?? null,
    lpHolderCount: numeric(r?.lp_holder_count),
    top10HolderPct,
    raw: r,
  };
}

async function fetchBatch(addresses: string[]): Promise<Map<string, TokenSecurity>> {
  const map = new Map<string, TokenSecurity>();
  const url = `${GOPLUS_API}/token_security/${config.goplus.chainId}?contract_addresses=${addresses.join(",")}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      log.warn("goplus", `token_security ${res.status}`);
      return map;
    }
    const data: any = await res.json();
    const result = data?.result ?? {};
    for (const [addr, r] of Object.entries(result)) {
      map.set(addr.toLowerCase(), parseSecurity(addr, r));
    }
  } catch (e) {
    log.warn("goplus", `request failed: ${(e as Error).message}`);
  }
  return map;
}

/** Batch token-security lookups. Returns a map keyed by lowercased address. */
export async function getTokenSecurityBatch(
  addresses: string[],
): Promise<Map<string, TokenSecurity>> {
  const out = new Map<string, TokenSecurity>();
  if (!config.goplus.enabled || addresses.length === 0) return out;
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];
  // GoPlus accepts comma-separated addresses; keep chunks small for rate limits.
  const chunks = chunk(unique, 20);
  const maps = await pMap(chunks, fetchBatch, 2);
  for (const m of maps) for (const [k, v] of m) out.set(k, v);
  if (out.size === 0) {
    log.warn(
      "goplus",
      `no security data (chain_id=${config.goplus.chainId}). If Monad is unindexed, set goplusEnabled=false or adjust GOPLUS_CHAIN_ID.`,
    );
  } else {
    log.info("goplus", `security for ${out.size}/${unique.length} token(s)`);
  }
  return out;
}

export async function getTokenSecurity(address: string): Promise<TokenSecurity | null> {
  const map = await getTokenSecurityBatch([address]);
  return map.get(address.toLowerCase()) ?? null;
}
