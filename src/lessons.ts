/**
 * Learning engine — "learns from past trades".
 *
 * On every close we record a performance entry, re-derive concise lessons
 * (PREFER/AVOID by strategy and bin step), and periodically evolve a screening
 * threshold. Lessons are surfaced to the operator and (later) injected into the
 * agent prompt. Threshold evolution is conservative and bounded.
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, config } from "./config";
import { log } from "./util/log";
import type { Strategy } from "./types";
import type { Position } from "./state";
import type { PositionPnl } from "./data/pnl";

const LESSONS_PATH = path.join(REPO_ROOT, "lessons.json");
const USER_CONFIG_PATH = path.join(REPO_ROOT, "user-config.json");

export interface Performance {
  ts: number;
  pool: string;
  name: string;
  strategy: Strategy;
  binStep: number;
  pnlPct: number | null;
  pnlUsd: number | null;
  depositUsd: number | null;
  durationMin: number;
  reason: string;
}

export interface Lesson {
  ts: number;
  kind: "PREFER" | "AVOID" | "NOTE";
  text: string;
}

interface LessonsFile {
  performance: Performance[];
  lessons: Lesson[];
}

function load(): LessonsFile {
  if (!fs.existsSync(LESSONS_PATH)) return { performance: [], lessons: [] };
  try {
    const d = JSON.parse(fs.readFileSync(LESSONS_PATH, "utf8"));
    return { performance: d.performance ?? [], lessons: d.lessons ?? [] };
  } catch {
    return { performance: [], lessons: [] };
  }
}

function save(f: LessonsFile): void {
  fs.writeFileSync(LESSONS_PATH, JSON.stringify(f, null, 2));
}

/** Average pnl% + win rate for entries grouped by a key (only evaluated pnl). */
function groupStats(perf: Performance[], keyOf: (p: Performance) => string) {
  const groups = new Map<string, { n: number; sum: number; wins: number }>();
  for (const p of perf) {
    if (p.pnlPct == null) continue;
    const k = keyOf(p);
    const g = groups.get(k) ?? { n: 0, sum: 0, wins: 0 };
    g.n++;
    g.sum += p.pnlPct;
    if (p.pnlPct > 0) g.wins++;
    groups.set(k, g);
  }
  return groups;
}

function deriveLessons(perf: Performance[]): Lesson[] {
  const out: Lesson[] = [];
  const now = Date.now();
  const MIN_SAMPLES = 3;

  for (const [strat, g] of groupStats(perf, (p) => p.strategy)) {
    if (g.n < MIN_SAMPLES) continue;
    const avg = g.sum / g.n;
    const wr = ((g.wins / g.n) * 100).toFixed(0);
    if (avg > 0) out.push({ ts: now, kind: "PREFER", text: `strategy "${strat}": avg ${avg.toFixed(1)}% over ${g.n} closes (win ${wr}%)` });
    else out.push({ ts: now, kind: "AVOID", text: `strategy "${strat}": avg ${avg.toFixed(1)}% over ${g.n} closes (win ${wr}%)` });
  }
  for (const [bs, g] of groupStats(perf, (p) => `binStep ${p.binStep}`)) {
    if (g.n < MIN_SAMPLES) continue;
    const avg = g.sum / g.n;
    if (avg < 0) out.push({ ts: now, kind: "AVOID", text: `${bs}: avg ${avg.toFixed(1)}% over ${g.n} closes` });
  }
  return out.slice(0, 10);
}

/** Conservative, bounded threshold evolution after every N closes. */
function maybeEvolve(perf: LessonsFile): void {
  const every = config.schedule.evolveEveryCloses;
  if (every <= 0 || perf.performance.length === 0 || perf.performance.length % every !== 0) return;
  const evaluated = perf.performance.filter((p) => p.pnlPct != null);
  if (evaluated.length < every) return;
  const avg = evaluated.reduce((s, p) => s + (p.pnlPct ?? 0), 0) / evaluated.length;

  // Negative recent performance → demand higher fee/TVL; positive → relax to explore.
  const current = Number(config.screening.minFeeTvlRatio ?? 0);
  const factor = avg < 0 ? 1.1 : 0.9;
  const next = Math.min(1, Math.max(0, current === 0 ? (avg < 0 ? 0.0005 : 0) : current * factor));
  if (next === current) return;

  config.screening.minFeeTvlRatio = next;
  const u: Record<string, any> = fs.existsSync(USER_CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
    : {};
  u.minFeeTvlRatio = next;
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(u, null, 2));
  const note: Lesson = {
    ts: Date.now(),
    kind: "NOTE",
    text: `[evolved] minFeeTvlRatio ${current} → ${next} (avg pnl ${avg.toFixed(1)}% over ${evaluated.length} closes)`,
  };
  perf.lessons.unshift(note);
  log.info("lessons", note.text);
}

/** Record a closed position's outcome and refresh lessons. */
export function recordClose(position: Position, pnl: PositionPnl | null, reason: string): Performance {
  const f = load();
  const entry: Performance = {
    ts: Date.now(),
    pool: position.pool,
    name: position.name,
    strategy: position.strategy,
    binStep: position.binStep,
    pnlPct: pnl?.pnlPct ?? null,
    pnlUsd: pnl?.pnlUsd ?? null,
    depositUsd: position.depositValueUsd,
    durationMin: Math.round((Date.now() - position.deployedAt) / 60_000),
    reason,
  };
  f.performance.push(entry);
  maybeEvolve(f);
  f.lessons = [...f.lessons.filter((l) => l.kind === "NOTE"), ...deriveLessons(f.performance)].slice(0, 20);
  save(f);
  return entry;
}

export function getLessons(): Lesson[] {
  return load().lessons;
}

export function getPerformanceSummary() {
  const perf = load().performance;
  const evaluated = perf.filter((p) => p.pnlPct != null);
  const wins = evaluated.filter((p) => (p.pnlPct ?? 0) > 0).length;
  const avg = evaluated.length ? evaluated.reduce((s, p) => s + (p.pnlPct ?? 0), 0) / evaluated.length : null;
  return {
    closes: perf.length,
    evaluated: evaluated.length,
    wins,
    winRatePct: evaluated.length ? (wins / evaluated.length) * 100 : null,
    avgPnlPct: avg,
  };
}
