/**
 * Decision log — a rolling, auditable record of what the agent did and why.
 * JSON at repo root (max 100 entries). Surfaced via the `decisions` CLI and,
 * later, injected into the LLM prompt so the agent can explain itself.
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./config";

const LOG_PATH = path.join(REPO_ROOT, "decision-log.json");
const MAX_ENTRIES = 100;

export type DecisionType =
  | "screen_deploy"
  | "screen_skip"
  | "no_deploy"
  | "manage_close"
  | "manage_stay"
  | "manage_claim";

export interface Decision {
  id: number;
  ts: number;
  type: DecisionType;
  actor: "SCREENER" | "MANAGER";
  pool: string | null;
  name: string | null;
  summary: string;
  reason: string;
  metrics: Record<string, unknown>;
}

interface LogFile {
  decisions: Decision[];
}

function load(): LogFile {
  if (!fs.existsSync(LOG_PATH)) return { decisions: [] };
  try {
    const d = JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
    return { decisions: Array.isArray(d?.decisions) ? d.decisions : [] };
  } catch {
    return { decisions: [] };
  }
}

function save(log: LogFile): void {
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
}

export function appendDecision(
  d: Omit<Decision, "id" | "ts">,
): Decision {
  const log = load();
  const last = log.decisions[log.decisions.length - 1];
  const entry: Decision = { id: (last?.id ?? 0) + 1, ts: Date.now(), ...d };
  log.decisions.push(entry);
  if (log.decisions.length > MAX_ENTRIES) {
    log.decisions = log.decisions.slice(-MAX_ENTRIES);
  }
  save(log);
  return entry;
}

export function getRecentDecisions(limit = 20): Decision[] {
  const { decisions } = load();
  return decisions.slice(-limit).reverse(); // newest first
}
