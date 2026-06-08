/**
 * Position registry — JSON store at repo root (no DB), mirroring Meridian's
 * file-based state. Bigints are persisted as strings.
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./config";
import type { Strategy } from "./types";

const STATE_PATH = path.join(REPO_ROOT, "state.json");

export interface Position {
  id: string; // `${pool}-${deployedAt}`
  pool: string;
  name: string;
  tokenX: string;
  tokenY: string;
  symbolX: string;
  symbolY: string;
  decimalsX: number;
  decimalsY: number;
  binStep: number;
  strategy: Strategy;
  activeIdAtDeploy: number;
  deltaIds: number[];
  binIds: number[];
  amountXRaw: string;
  amountYRaw: string;
  amountXHuman: number;
  amountYHuman: number;
  depositValueUsd: number | null;
  priceXusdAtDeploy: number | null;
  priceYusdAtDeploy: number | null;
  dryRun: boolean;
  txHash: string | null;
  deployedAt: number;
  closed: boolean;
  closedAt: number | null;
  closeTxHash: string | null;
  notes: string;
}

interface StateFile {
  positions: Position[];
}

function load(): StateFile {
  if (!fs.existsSync(STATE_PATH)) return { positions: [] };
  try {
    const data = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return { positions: Array.isArray(data?.positions) ? data.positions : [] };
  } catch {
    return { positions: [] };
  }
}

function save(state: StateFile): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function addPosition(p: Position): void {
  const state = load();
  state.positions.push(p);
  save(state);
}

export function getPositions(): Position[] {
  return load().positions;
}

export function getOpenPositions(): Position[] {
  return load().positions.filter((p) => !p.closed);
}

export function getPosition(id: string): Position | null {
  return load().positions.find((p) => p.id === id) ?? null;
}

/** Find a position by id, full pool address, or 1-based open-position index. */
export function resolvePosition(ref: string): Position | null {
  const all = load().positions;
  const byId = all.find((p) => p.id === ref);
  if (byId) return byId;
  const byPool = all.find((p) => !p.closed && p.pool.toLowerCase() === ref.toLowerCase());
  if (byPool) return byPool;
  const idx = Number(ref);
  if (Number.isInteger(idx) && idx >= 1) {
    const open = all.filter((p) => !p.closed);
    if (idx <= open.length) return open[idx - 1];
  }
  return null;
}

export function markClosed(id: string, closeTxHash: string | null): void {
  const state = load();
  const p = state.positions.find((x) => x.id === id);
  if (!p) return;
  p.closed = true;
  p.closedAt = Date.now();
  p.closeTxHash = closeTxHash;
  save(state);
}
