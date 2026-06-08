/**
 * Screen cycle — the deterministic deploy half.
 *
 * Rank candidates, drop pools/tokens already held, optionally auto-open the
 * top pick (DRY_RUN-aware). Every outcome is recorded to the decision log.
 * The LLM layer (Phase 3b) will replace the "pick #1" heuristic with reasoned
 * selection; the mechanics (caps, occupancy, open) stay here.
 */
import { config } from "./config";
import { getTopCandidates } from "./screening";
import { getOpenPositions } from "./state";
import { openPosition, type OpenResult } from "./chain/lb-write";
import { appendDecision } from "./decision-log";
import { log } from "./util/log";
import type { Candidate } from "./types";

export interface ScreenCycleResult {
  picked: Candidate | null;
  deployed: boolean;
  reason: string;
  candidates: Candidate[];
  openResult: OpenResult | null;
}

export async function runScreenCycle(opts: {
  deploy?: boolean;
  amountX?: number;
  amountY?: number;
  limit?: number;
} = {}): Promise<ScreenCycleResult> {
  const deploy = opts.deploy ?? false;
  const limit = opts.limit ?? 10;
  const amountX = opts.amountX ?? config.management.deployAmountX;
  const amountY = opts.amountY ?? config.management.deployAmountY;

  const open = getOpenPositions();
  if (open.length >= config.management.maxPositions) {
    const reason = `at maxPositions (${open.length}/${config.management.maxPositions})`;
    appendDecision({ type: "no_deploy", actor: "SCREENER", pool: null, name: null, summary: "skip screen", reason, metrics: { open: open.length } });
    return { picked: null, deployed: false, reason, candidates: [], openResult: null };
  }

  const occupiedPools = new Set(open.map((p) => p.pool.toLowerCase()));
  const occupiedTokens = new Set(open.flatMap((p) => [p.tokenX.toLowerCase(), p.tokenY.toLowerCase()]));

  const { candidates } = await getTopCandidates({ limit });
  const eligible = candidates.filter(
    (c) =>
      !occupiedPools.has(c.pool.toLowerCase()) &&
      !occupiedTokens.has(c.base.address.toLowerCase()),
  );

  if (eligible.length === 0) {
    const reason = candidates.length ? "all candidates already held" : "no candidates passed filters";
    appendDecision({ type: "no_deploy", actor: "SCREENER", pool: null, name: null, summary: "no deploy", reason, metrics: { screened: candidates.length } });
    return { picked: null, deployed: false, reason, candidates, openResult: null };
  }

  const pick = eligible[0];

  // No amounts → selection only (don't open).
  if (!deploy || (amountX <= 0 && amountY <= 0)) {
    const reason = !deploy
      ? "selection only (pass --deploy to open)"
      : "no deploy amount set (deployAmountX/Y or --amount-x/--amount-y)";
    appendDecision({
      type: "screen_skip",
      actor: "SCREENER",
      pool: pick.pool,
      name: pick.name,
      summary: `selected ${pick.name}`,
      reason,
      metrics: { score: pick.score, feeTvlRatio: pick.feeTvlRatio, tvl: pick.tvlUsd, binStep: pick.binStep },
    });
    return { picked: pick, deployed: false, reason, candidates: eligible, openResult: null };
  }

  // Auto-deploy the top pick (DRY_RUN-aware inside openPosition).
  log.info("screen", `deploying into ${pick.name} (${amountX} X / ${amountY} Y)`);
  const openResult = await openPosition({ pool: pick.pool, amountX, amountY });
  appendDecision({
    type: "screen_deploy",
    actor: "SCREENER",
    pool: pick.pool,
    name: pick.name,
    summary: `deploy ${pick.name}`,
    reason: `top-ranked (score ${pick.score.toFixed(1)})`,
    metrics: {
      score: pick.score,
      depositUsd: openResult.position.depositValueUsd,
      dryRun: openResult.dryRun,
      bins: openResult.position.binIds.length,
    },
  });
  return { picked: pick, deployed: true, reason: "deployed top pick", candidates: eligible, openResult };
}
