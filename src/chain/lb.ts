/**
 * LFJ Liquidity Book (DLMM) read-only reader for Monad.
 *
 * Discovery is authoritative & on-chain: LBFactory enumerates every LBPair.
 * Per-pair we read binStep / activeId / reserves / fee params and derive the
 * base fee % and the active-bin price. No SDK is used (the public joe-sdk-v2 is
 * archived and lacks Monad), so we talk to the verified v2.2 contracts directly.
 */
import { ethers } from "ethers";
import { getProvider } from "./client";
import { LB_FACTORY_ABI, LB_PAIR_ABI, ERC20_ABI } from "./abis";
import {
  LB_FACTORY,
  LB_ACTIVE_ID_OFFSET,
  LB_BASE_FEE_DENOMINATOR,
} from "../constants";
import { pMap } from "../util/num";
import { log } from "../util/log";
import type { LbPairOnchain } from "../types";

// ─── token metadata cache ────────────────────────────────────────────
interface TokenMeta {
  symbol: string;
  decimals: number;
}
const _tokenMeta = new Map<string, TokenMeta>();

async function getTokenMeta(addr: string): Promise<TokenMeta> {
  const key = addr.toLowerCase();
  const cached = _tokenMeta.get(key);
  if (cached) return cached;
  const c = new ethers.Contract(addr, ERC20_ABI, getProvider());
  let symbol = "?";
  let decimals = 18;
  try {
    symbol = await c.symbol();
  } catch {
    /* non-standard token (e.g. bytes32 symbol) */
  }
  try {
    decimals = Number(await c.decimals());
  } catch {
    /* default 18 */
  }
  const meta = { symbol, decimals };
  _tokenMeta.set(key, meta);
  return meta;
}

// ─── factory enumeration ─────────────────────────────────────────────

/** Every LBPair address the LFJ v2.2 factory has created on Monad. */
export async function getAllLbPairAddresses(): Promise<string[]> {
  const factory = new ethers.Contract(LB_FACTORY, LB_FACTORY_ABI, getProvider());
  const count = Number(await factory.getNumberOfLBPairs());
  log.info("lb", `LBFactory reports ${count} LBPair(s) on Monad`);
  if (count === 0) return [];
  const indices = Array.from({ length: count }, (_, i) => i);
  const addresses = await pMap(
    indices,
    (i) => factory.getLBPairAtIndex(i) as Promise<string>,
    8,
  );
  return addresses.map((a) => a);
}

// ─── per-pair reads ──────────────────────────────────────────────────

/** Base swap fee as a percentage (e.g. 0.25 = 0.25%). */
export function baseFeePct(baseFactor: number, binStep: number): number {
  // fee fraction = baseFactor * binStep / 1e8  →  percentage = ×100
  return (baseFactor * binStep) / LB_BASE_FEE_DENOMINATOR * 100;
}

/** Human price of 1 tokenX denominated in tokenY, from the active bin id. */
export function priceFromActiveId(
  activeId: number,
  binStep: number,
  decimalsX: number,
  decimalsY: number,
): number {
  const raw = Math.pow(1 + binStep / 10_000, activeId - LB_ACTIVE_ID_OFFSET);
  return raw * Math.pow(10, decimalsX - decimalsY);
}

/** Read all screening-relevant state from a single LBPair. */
export async function readPair(pairAddress: string): Promise<LbPairOnchain> {
  const pair = new ethers.Contract(pairAddress, LB_PAIR_ABI, getProvider());

  const [tokenX, tokenY, binStepRaw, activeIdRaw, reserves, staticFee] =
    await Promise.all([
      pair.getTokenX() as Promise<string>,
      pair.getTokenY() as Promise<string>,
      pair.getBinStep() as Promise<bigint>,
      pair.getActiveId() as Promise<bigint>,
      pair.getReserves() as Promise<[bigint, bigint]>,
      pair.getStaticFeeParameters() as Promise<bigint[]>,
    ]);

  const [metaX, metaY] = await Promise.all([
    getTokenMeta(tokenX),
    getTokenMeta(tokenY),
  ]);

  const binStep = Number(binStepRaw);
  const activeId = Number(activeIdRaw);
  const baseFactor = Number(staticFee[0]);

  return {
    pair: pairAddress,
    tokenX,
    tokenY,
    symbolX: metaX.symbol,
    symbolY: metaY.symbol,
    decimalsX: metaX.decimals,
    decimalsY: metaY.decimals,
    binStep,
    activeId,
    reserveX: reserves[0],
    reserveY: reserves[1],
    baseFeePct: baseFeePct(baseFactor, binStep),
    priceXinY: priceFromActiveId(activeId, binStep, metaX.decimals, metaY.decimals),
  };
}

/** Read many pairs with bounded concurrency; failures resolve to null. */
export async function readPairs(
  addresses: string[],
  concurrency = 6,
): Promise<(LbPairOnchain | null)[]> {
  return pMap(
    addresses,
    async (addr) => {
      try {
        return await readPair(addr);
      } catch (e) {
        log.debug("lb", `readPair ${addr.slice(0, 10)} failed: ${(e as Error).message}`);
        return null;
      }
    },
    concurrency,
  );
}
