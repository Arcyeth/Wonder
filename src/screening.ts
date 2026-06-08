/**
 * Wonder screening engine (Phase 1, read-only).
 *
 * Pipeline (mirrors Meridian's discover → hard-filter → enrich → score, but
 * sourced for Monad/LFJ):
 *   1. enumerate LBPairs on-chain (LBFactory)            — authoritative list
 *   2. DexScreener metrics for all pairs                 — TVL/volume/mcap/price
 *   3. cheap pre-filter (TVL/volume/mcap) → shortlist    — limit heavy reads
 *   4. on-chain reads for shortlist (binStep/fee/price)  — LB specifics
 *   5. GoPlus security for shortlist base tokens         — honeypot/holders/top10
 *   6. compute feeTvlRatio + organicProxy, hard-filter, score, sort
 *
 * Scoring mirrors Meridian: feeTvl*1000 + organic*10 + volume/100 + holders/100.
 */
import { config, type Timeframe } from "./config";
import { getAllLbPairAddresses, readPairs, readPair } from "./chain/lb";
import { getPairsByAddresses, getPair } from "./data/dexscreener";
import { getTokenSecurityBatch, getTokenSecurity } from "./data/goplus";
import { numeric, round, fix } from "./util/num";
import { log } from "./util/log";
import type {
  Candidate,
  DexPair,
  LbPairOnchain,
  TokenSecurity,
  FilteredReason,
  ScreenResult,
} from "./types";

const s = () => config.screening;

function windowVolume(dex: DexPair, tf: Timeframe): number {
  return dex.volume[tf] ?? 0;
}

/** 0-100 synthesized "organic" proxy (no Jupiter organic-score on Monad). */
function organicProxy(dex: DexPair, tf: Timeframe, holders: number | null): number {
  const buys = dex.txns[tf]?.buys ?? 0;
  const sells = dex.txns[tf]?.sells ?? 0;
  const total = buys + sells;
  const balance = total > 0 ? 1 - Math.abs(buys - sells) / total : 0;
  const vol = windowVolume(dex, tf);
  const volumeScore = vol > 0 ? Math.min(1, Math.log10(vol + 1) / 5) : 0;
  const holderScore = holders != null ? Math.min(1, holders / 500) : 0;
  return Math.round(100 * (0.4 * balance + 0.3 * volumeScore + 0.3 * holderScore));
}

function scoreCandidate(c: Candidate): number {
  const feeTvl = c.feeTvlRatio ?? 0;
  const organic = c.organicProxy ?? 0;
  const volume = c.volumeWindow ?? 0;
  const holders = c.holders ?? 0;
  return feeTvl * 1000 + organic * 10 + volume / 100 + holders / 100;
}

/** Assemble a Candidate from its data sources. */
function buildCandidate(
  dex: DexPair,
  oc: LbPairOnchain | null,
  sec: TokenSecurity | null,
  tf: Timeframe,
): Candidate {
  const tvl = dex.liquidityUsd;
  const volume = windowVolume(dex, tf);
  const feePct = oc?.baseFeePct ?? null;
  const feeWindow = feePct != null ? volume * (feePct / 100) : null;
  const feeTvlRatio = feeWindow != null && tvl && tvl > 0 ? feeWindow / tvl : null;
  const holders = sec?.holderCount ?? null;
  const mcap = dex.marketCap ?? dex.fdv ?? null;
  const ageHours = dex.pairCreatedAt
    ? Math.floor((Date.now() - dex.pairCreatedAt) / 3_600_000)
    : null;
  const buys = dex.txns[tf]?.buys ?? 0;
  const sells = dex.txns[tf]?.sells ?? 0;

  const c: Candidate = {
    pool: dex.pairAddress,
    name: `${dex.baseToken.symbol}-${dex.quoteToken.symbol}`,
    base: { symbol: dex.baseToken.symbol, address: dex.baseToken.address },
    quote: { symbol: dex.quoteToken.symbol, address: dex.quoteToken.address },
    binStep: oc?.binStep ?? null,
    feePct: feePct != null ? fix(feePct, 4) : null,
    activeId: oc?.activeId ?? null,
    priceUsd: dex.priceUsd,
    priceXinY: oc ? fix(oc.priceXinY, 8) : null,
    tvlUsd: round(tvl),
    volumeWindow: round(volume),
    feeWindow: feeWindow != null ? fix(feeWindow, 2) : null,
    feeTvlRatio: feeTvlRatio != null ? fix(feeTvlRatio, 5) : null,
    timeframe: tf,
    holders,
    mcap: round(mcap),
    fdv: round(dex.fdv),
    ageHours,
    organicProxy: organicProxy(dex, tf, holders),
    buys,
    sells,
    buySellRatio: sells > 0 ? fix(buys / sells, 2) : buys > 0 ? null : 0,
    priceChangePct: fix(dex.priceChange[tf], 2),
    security: sec,
    score: 0,
  };
  c.score = scoreCandidate(c);
  return c;
}

/** Return a rejection reason, or null if the candidate passes all hard gates. */
function rejectReason(c: Candidate): string | null {
  const cfg = s();
  const tvl = c.tvlUsd ?? 0;
  if (cfg.minTvl != null && tvl < cfg.minTvl) return `TVL ${tvl} < minTvl ${cfg.minTvl}`;
  if (cfg.maxTvl != null && tvl > cfg.maxTvl) return `TVL ${tvl} > maxTvl ${cfg.maxTvl}`;
  if (cfg.minVolume != null && (c.volumeWindow ?? 0) < cfg.minVolume)
    return `volume ${c.volumeWindow ?? 0} < minVolume ${cfg.minVolume}`;
  if (c.mcap != null) {
    if (cfg.minMcap != null && c.mcap < cfg.minMcap) return `mcap ${c.mcap} < minMcap ${cfg.minMcap}`;
    if (cfg.maxMcap != null && c.mcap > cfg.maxMcap) return `mcap ${c.mcap} > maxMcap ${cfg.maxMcap}`;
  }
  if (c.binStep != null) {
    if (cfg.minBinStep != null && c.binStep < cfg.minBinStep)
      return `binStep ${c.binStep} < minBinStep ${cfg.minBinStep}`;
    if (cfg.maxBinStep != null && c.binStep > cfg.maxBinStep)
      return `binStep ${c.binStep} > maxBinStep ${cfg.maxBinStep}`;
  }
  if (cfg.minFeeTvlRatio > 0 && (c.feeTvlRatio ?? 0) < cfg.minFeeTvlRatio)
    return `feeTvlRatio ${c.feeTvlRatio ?? 0} < minFeeTvlRatio ${cfg.minFeeTvlRatio}`;
  if (cfg.minOrganicProxy > 0 && c.organicProxy < cfg.minOrganicProxy)
    return `organicProxy ${c.organicProxy} < minOrganicProxy ${cfg.minOrganicProxy}`;
  if (cfg.minAgeHours != null && c.ageHours != null && c.ageHours < cfg.minAgeHours)
    return `age ${c.ageHours}h < minAgeHours ${cfg.minAgeHours}`;
  if (cfg.maxAgeHours != null && c.ageHours != null && c.ageHours > cfg.maxAgeHours)
    return `age ${c.ageHours}h > maxAgeHours ${cfg.maxAgeHours}`;

  // ── security gates (only when GoPlus actually returned data) ──
  const sec = c.security;
  if (sec) {
    if (cfg.rejectHoneypot && sec.isHoneypot === true) return "honeypot (GoPlus)";
    if (sec.buyTaxPct != null && sec.buyTaxPct > cfg.maxBuyTaxPct)
      return `buyTax ${sec.buyTaxPct}% > ${cfg.maxBuyTaxPct}%`;
    if (sec.sellTaxPct != null && sec.sellTaxPct > cfg.maxSellTaxPct)
      return `sellTax ${sec.sellTaxPct}% > ${cfg.maxSellTaxPct}%`;
    if (sec.top10HolderPct != null && sec.top10HolderPct > cfg.maxTop10Pct)
      return `top10 ${sec.top10HolderPct.toFixed(1)}% > ${cfg.maxTop10Pct}%`;
    if (cfg.requireOpenSource && sec.isOpenSource === false) return "not open source";
    if (sec.holderCount != null && cfg.minHolders != null && sec.holderCount < cfg.minHolders)
      return `holders ${sec.holderCount} < minHolders ${cfg.minHolders}`;
  }
  return null;
}

/**
 * Discover & enrich all LFJ pools that survive the cheap pre-filter.
 * Returns enriched candidates (pre hard-filter) plus reasons for the obvious drops.
 */
export async function discoverPools(): Promise<{
  candidates: Candidate[];
  preFiltered: number;
  filteredExamples: FilteredReason[];
}> {
  const tf = s().timeframe as Timeframe;
  const addresses = await getAllLbPairAddresses();
  if (addresses.length === 0) return { candidates: [], preFiltered: 0, filteredExamples: [] };

  const dexMap = await getPairsByAddresses(addresses);

  // Cheap pre-filter on DexScreener metrics to bound expensive reads.
  const filteredExamples: FilteredReason[] = [];
  const prelim: DexPair[] = [];
  for (const addr of addresses) {
    const dex = dexMap.get(addr.toLowerCase());
    if (!dex) continue; // no market data → skip (illiquid/unindexed)
    const tvl = dex.liquidityUsd ?? 0;
    const vol = dex.volume[tf] ?? 0;
    if (tvl < s().minTvl && vol < s().minVolume) {
      filteredExamples.push({
        name: `${dex.baseToken.symbol}-${dex.quoteToken.symbol}`,
        reason: `pre-filter: TVL ${round(tvl)} & vol ${round(vol)} both below floors`,
      });
      continue;
    }
    prelim.push(dex);
  }

  // Rank pre-filtered pools by DexScreener TVL and cap heavy enrichment.
  prelim.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
  const shortlist = prelim.slice(0, s().maxPairsToEnrich);
  log.info(
    "screening",
    `${addresses.length} pairs → ${prelim.length} pre-filtered → enriching top ${shortlist.length}`,
  );

  // On-chain LB reads + GoPlus security, in parallel.
  const [ocList, secMap] = await Promise.all([
    readPairs(shortlist.map((d) => d.pairAddress)),
    getTokenSecurityBatch(shortlist.map((d) => d.baseToken.address)),
  ]);
  const ocByPair = new Map<string, LbPairOnchain>();
  for (const oc of ocList) if (oc) ocByPair.set(oc.pair.toLowerCase(), oc);

  const candidates = shortlist.map((dex) =>
    buildCandidate(
      dex,
      ocByPair.get(dex.pairAddress.toLowerCase()) ?? null,
      secMap.get(dex.baseToken.address.toLowerCase()) ?? null,
      tf,
    ),
  );

  return { candidates, preFiltered: prelim.length, filteredExamples };
}

/** Hard-filter, score, and rank — the agent/CLI-facing entry point. */
export async function getTopCandidates({ limit = 10 } = {}): Promise<ScreenResult> {
  const { candidates, filteredExamples } = await discoverPools();
  const passed: Candidate[] = [];
  const drops = [...filteredExamples];
  for (const c of candidates) {
    const reason = rejectReason(c);
    if (reason) {
      drops.push({ name: c.name, reason });
      continue;
    }
    passed.push(c);
  }
  passed.sort((a, b) => b.score - a.score);
  return {
    candidates: passed.slice(0, limit),
    totalScreened: candidates.length,
    filteredExamples: drops.slice(0, 8),
  };
}

/** Full enrichment for one pool (pool-detail). */
export async function getPoolDetail(pairAddress: string): Promise<{
  candidate: Candidate | null;
  onchain: LbPairOnchain | null;
  dex: DexPair | null;
  security: TokenSecurity | null;
}> {
  const tf = s().timeframe as Timeframe;
  const [dex, oc] = await Promise.all([
    getPair(pairAddress),
    readPair(pairAddress).catch(() => null),
  ]);
  if (!dex && !oc) return { candidate: null, onchain: null, dex: null, security: null };
  const baseAddr = dex?.baseToken.address ?? oc?.tokenX ?? "";
  const security = baseAddr ? await getTokenSecurity(baseAddr) : null;
  const candidate = dex ? buildCandidate(dex, oc, security, tf) : null;
  return { candidate, onchain: oc, dex, security };
}
