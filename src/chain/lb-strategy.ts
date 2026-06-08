/**
 * Liquidity Book distribution math — the core of opening a DLMM position.
 *
 * A position spans bins from (activeId - binsBelow) to (activeId + binsAbove).
 * In LB, bins BELOW the active price hold only tokenY, bins ABOVE hold only
 * tokenX, and the active bin can hold both. `distributionX`/`distributionY`
 * are the per-bin fractions (1e18 precision) of each token's total amount;
 * each side must sum to exactly 1e18 (when that side has a non-zero amount).
 *
 * Strategy shapes (matching the LFJ/Meteora SDK semantics):
 *   - spot    : uniform weight across the side's bins
 *   - curve   : weight concentrated at the active bin, tapering to the edges
 *   - bid_ask : weight concentrated at the edges (V-shape), light at center
 */
import type { Strategy } from "../types";

export const PRECISION = 10n ** 18n;

export interface Distribution {
  deltaIds: number[]; // relative offsets, ascending (e.g. -10..+10)
  ids: number[]; // absolute bin ids (activeId + delta)
  distributionX: bigint[]; // per-bin fraction of amountX (sum = 1e18 if hasX)
  distributionY: bigint[]; // per-bin fraction of amountY (sum = 1e18 if hasY)
}

/** Integer weight for a bin at `distance` from the active bin on a side of `count` bins. */
function weight(distance: number, count: number, strategy: Strategy): number {
  switch (strategy) {
    case "spot":
      return 1;
    case "curve":
      return count - distance; // active bin heaviest
    case "bid_ask":
      return distance + 1; // edges heaviest
    default:
      return 1;
  }
}

/** Normalize integer weights into 1e18-precision fractions summing exactly to 1e18. */
function normalize(weights: number[]): bigint[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return weights.map(() => 0n);
  const out = weights.map((w) => (BigInt(w) * PRECISION) / BigInt(total));
  // Push the rounding remainder onto the heaviest bin so the side sums to 1e18.
  const sum = out.reduce((s, v) => s + v, 0n);
  const remainder = PRECISION - sum;
  if (remainder !== 0n) {
    let maxIdx = 0;
    for (let i = 1; i < weights.length; i++) if (weights[i] > weights[maxIdx]) maxIdx = i;
    out[maxIdx] += remainder;
  }
  return out;
}

export function buildDistribution(opts: {
  activeId: number;
  binsBelow: number;
  binsAbove: number;
  strategy: Strategy;
  hasX: boolean; // deploying tokenX (>0)?
  hasY: boolean; // deploying tokenY (>0)?
}): Distribution {
  const { activeId, binsBelow, binsAbove, strategy, hasX, hasY } = opts;

  const deltaIds: number[] = [];
  for (let d = -binsBelow; d <= binsAbove; d++) deltaIds.push(d);
  const ids = deltaIds.map((d) => activeId + d);

  // ── X side: active + above (delta >= 0) ──
  const xDeltas = deltaIds.filter((d) => d >= 0);
  const xWeights = xDeltas.map((d) => weight(d, binsAbove + 1, strategy));
  const xNorm = hasX ? normalize(xWeights) : xWeights.map(() => 0n);

  // ── Y side: active + below (delta <= 0); distance grows downward ──
  const yDeltas = deltaIds.filter((d) => d <= 0);
  const yWeights = yDeltas.map((d) => weight(-d, binsBelow + 1, strategy));
  const yNorm = hasY ? normalize(yWeights) : yWeights.map(() => 0n);

  // Map back onto the full deltaIds array (0 where a side is not eligible).
  const xByDelta = new Map(xDeltas.map((d, i) => [d, xNorm[i]]));
  const yByDelta = new Map(yDeltas.map((d, i) => [d, yNorm[i]]));
  const distributionX = deltaIds.map((d) => xByDelta.get(d) ?? 0n);
  const distributionY = deltaIds.map((d) => yByDelta.get(d) ?? 0n);

  return { deltaIds, ids, distributionX, distributionY };
}

/** Per-bin token amounts (raw) implied by a distribution — for inspection/logging. */
export function perBinAmounts(
  amountXRaw: bigint,
  amountYRaw: bigint,
  dist: Distribution,
): { id: number; deltaId: number; amountX: bigint; amountY: bigint }[] {
  return dist.deltaIds.map((deltaId, i) => ({
    id: dist.ids[i],
    deltaId,
    amountX: (amountXRaw * dist.distributionX[i]) / PRECISION,
    amountY: (amountYRaw * dist.distributionY[i]) / PRECISION,
  }));
}
