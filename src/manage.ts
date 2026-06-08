/**
 * Manage cycle — the deterministic half of the agent's brain.
 *
 * For each open position: read on-chain PnL, apply hard exit rules
 * (stop-loss / take-profit / out-of-range), and act (close, DRY_RUN-aware).
 * Every evaluation is recorded to the decision log. An LLM layer (Phase 3b)
 * will sit on top for the ambiguous cases; the rules below are mechanical.
 */
import { config } from "./config";
import { getOpenPositions, type Position } from "./state";
import { computePositionPnl, type PositionPnl } from "./data/pnl";
import { closePosition } from "./chain/lb-write";
import { appendDecision } from "./decision-log";
import { walletAddress } from "./chain/wallet";
import { log } from "./util/log";

export type ManageActionKind = "STAY" | "CLOSE" | "CLAIM";

export interface ManageAction {
  kind: ManageActionKind;
  reason: string;
}

type MgmtCfg = typeof config.management;

/** Pure exit-rule evaluation — easy to unit-test, no side effects. */
export function evaluatePosition(pnl: PositionPnl, cfg: MgmtCfg): ManageAction {
  if (!pnl.hasOnchainLiquidity) {
    return { kind: "STAY", reason: "no on-chain liquidity to evaluate (simulated/keyless)" };
  }
  if (pnl.pnlPct != null) {
    if (pnl.pnlPct <= cfg.stopLossPct) {
      return { kind: "CLOSE", reason: `stop-loss ${pnl.pnlPct.toFixed(1)}% <= ${cfg.stopLossPct}%` };
    }
    if (pnl.pnlPct >= cfg.takeProfitPct) {
      return { kind: "CLOSE", reason: `take-profit ${pnl.pnlPct.toFixed(1)}% >= ${cfg.takeProfitPct}%` };
    }
  }
  if (cfg.closeOnOutOfRange && pnl.inRange === false) {
    return { kind: "CLOSE", reason: "out of range" };
  }
  return { kind: "STAY", reason: "within thresholds" };
}

export interface ManageOutcome {
  position: Position;
  pnl: PositionPnl;
  action: ManageAction;
  executed: boolean;
  note: string;
}

export interface ManageCycleResult {
  evaluated: number;
  closed: number;
  stayed: number;
  walletPresent: boolean;
  outcomes: ManageOutcome[];
}

export async function runManageCycle(opts: { execute?: boolean } = {}): Promise<ManageCycleResult> {
  const execute = opts.execute ?? true;
  const open = getOpenPositions();
  const walletPresent = walletAddress() != null;
  const outcomes: ManageOutcome[] = [];
  let closed = 0;
  let stayed = 0;

  for (const p of open) {
    const pnl = await computePositionPnl(p);
    const action = evaluatePosition(pnl, config.management);
    let executed = false;
    let note = action.reason;

    if (action.kind === "CLOSE") {
      if (execute) {
        const res = await closePosition(p);
        executed = true;
        note = res.note;
        appendDecision({
          type: "manage_close",
          actor: "MANAGER",
          pool: p.pool,
          name: p.name,
          summary: `close ${p.name}`,
          reason: action.reason,
          metrics: { pnlPct: pnl.pnlPct, pnlUsd: pnl.pnlUsd, valueUsd: pnl.currentValueUsd, dryRun: res.dryRun },
        });
        closed++;
        log.info("manage", `CLOSE ${p.name}: ${action.reason}`);
      } else {
        appendDecision({
          type: "manage_close",
          actor: "MANAGER",
          pool: p.pool,
          name: p.name,
          summary: `would close ${p.name}`,
          reason: `${action.reason} (evaluate-only)`,
          metrics: { pnlPct: pnl.pnlPct },
        });
      }
    } else {
      stayed++;
      appendDecision({
        type: "manage_stay",
        actor: "MANAGER",
        pool: p.pool,
        name: p.name,
        summary: `stay ${p.name}`,
        reason: action.reason,
        metrics: { pnlPct: pnl.pnlPct, valueUsd: pnl.currentValueUsd },
      });
    }

    outcomes.push({ position: p, pnl, action, executed, note });
  }

  return { evaluated: open.length, closed, stayed, walletPresent, outcomes };
}
