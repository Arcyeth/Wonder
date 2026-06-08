/**
 * Position valuation & PnL.
 *
 * Position value is computed directly on-chain: the owner's share of each bin's
 * reserves (which already includes accrued fees) is summed and priced in USD
 * via DexScreener.
 */
import { ethers } from "ethers";
import { readPositionLiquidity } from "../chain/lb";
import { getPair } from "./dexscreener";
import { walletAddress } from "../chain/wallet";
import type { DexPair } from "../types";
import type { Position } from "../state";

/** USD price of tokenX and tokenY for a pair (maps DexScreener base/quote to X/Y). */
export function tokenUsdPrices(
  dex: DexPair | null,
  tokenX: string,
): { priceXusd: number | null; priceYusd: number | null } {
  if (!dex) return { priceXusd: null, priceYusd: null };
  const baseUsd = dex.priceUsd;
  const quoteUsd =
    dex.priceUsd != null && dex.priceNative != null && dex.priceNative > 0
      ? dex.priceUsd / dex.priceNative
      : null;
  const baseIsX = dex.baseToken.address.toLowerCase() === tokenX.toLowerCase();
  return baseIsX
    ? { priceXusd: baseUsd, priceYusd: quoteUsd }
    : { priceXusd: quoteUsd, priceYusd: baseUsd };
}

export interface PositionPnl {
  positionId: string;
  hasOnchainLiquidity: boolean;
  currentXHuman: number;
  currentYHuman: number;
  priceXusd: number | null;
  priceYusd: number | null;
  currentValueUsd: number | null;
  depositValueUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  inRange: boolean | null;
  binsWithLiquidity: number;
}

export async function computePositionPnl(p: Position): Promise<PositionPnl> {
  const owner = walletAddress();
  const empty: PositionPnl = {
    positionId: p.id,
    hasOnchainLiquidity: false,
    currentXHuman: 0,
    currentYHuman: 0,
    priceXusd: null,
    priceYusd: null,
    currentValueUsd: null,
    depositValueUsd: p.depositValueUsd,
    pnlUsd: null,
    pnlPct: null,
    inRange: null,
    binsWithLiquidity: 0,
  };
  if (!owner) return empty; // keyless dry-run: can't read on-chain shares

  const bins = await readPositionLiquidity(p.pool, owner, p.binIds);
  const withLiq = bins.filter((b) => b.balance > 0n);
  if (withLiq.length === 0) return empty;

  let userX = 0n;
  let userY = 0n;
  for (const b of bins) {
    userX += b.userX;
    userY += b.userY;
  }
  const currentXHuman = Number(ethers.formatUnits(userX, p.decimalsX));
  const currentYHuman = Number(ethers.formatUnits(userY, p.decimalsY));

  const dex = await getPair(p.pool);
  const { priceXusd, priceYusd } = tokenUsdPrices(dex, p.tokenX);
  const currentValueUsd =
    priceXusd != null && priceYusd != null
      ? currentXHuman * priceXusd + currentYHuman * priceYusd
      : null;
  const pnlUsd =
    currentValueUsd != null && p.depositValueUsd != null
      ? currentValueUsd - p.depositValueUsd
      : null;
  const pnlPct =
    pnlUsd != null && p.depositValueUsd && p.depositValueUsd > 0
      ? (pnlUsd / p.depositValueUsd) * 100
      : null;

  // In range if the current active bin still falls within the position's bins.
  const lo = Math.min(...p.binIds);
  const hi = Math.max(...p.binIds);
  let inRange: boolean | null = null;
  if (dex) {
    // active bin can be inferred from any bin still holding both-sided reserves;
    // fall back to liquidity presence near the middle.
    inRange = withLiq.some((b) => b.binReserveX > 0n && b.binReserveY > 0n);
  }
  void lo;
  void hi;

  return {
    positionId: p.id,
    hasOnchainLiquidity: true,
    currentXHuman,
    currentYHuman,
    priceXusd,
    priceYusd,
    currentValueUsd,
    depositValueUsd: p.depositValueUsd,
    pnlUsd,
    pnlPct,
    inRange,
    binsWithLiquidity: withLiq.length,
  };
}
