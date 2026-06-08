/**
 * Agent tools — JSON-schema definitions the LLM sees, plus the executor that
 * maps each call onto Wonder's existing functions. Mutating tools (open/close/
 * deploy) inherit DRY_RUN from config, so the agent can't broadcast unless the
 * operator has set DRY_RUN=false.
 */
import { getTopCandidates, getPoolDetail } from "../screening";
import { getOpenPositions, resolvePosition } from "../state";
import { computePositionPnl } from "../data/pnl";
import { getBalances } from "../chain/wallet";
import { getRecentDecisions } from "../decision-log";
import { openPosition, closePosition } from "../chain/lb-write";
import { runScreenCycle } from "../screen-cycle";
import { runManageCycle } from "../manage";
import { WMON } from "../constants";
import { log } from "../util/log";
import type { ToolDef } from "../llm";
import type { Strategy } from "../types";

export type Role = "SCREENER" | "MANAGER" | "GENERAL";

function safeJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val));
}

// ─── tool schemas ────────────────────────────────────────────────────
export const ALL_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "get_candidates",
      description: "Rank LFJ Liquidity Book pools on Monad by LP attractiveness (fee/TVL, volume, holders, security). Returns scored candidates.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "max candidates (default 10)" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_pool_detail",
      description: "Deep on-chain + market + security detail for one LBPair pool address.",
      parameters: {
        type: "object",
        properties: { pool: { type: "string", description: "LBPair address (0x...)" } },
        required: ["pool"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_positions",
      description: "List the agent's open LP positions (from local state).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_position_pnl",
      description: "On-chain PnL for one position (by id/pool/index) or all open positions if omitted.",
      parameters: {
        type: "object",
        properties: { position: { type: "string", description: "position id, pool address, or 1-based index" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_balances",
      description: "Wallet native MON + relevant token balances (requires WALLET_PRIVATE_KEY).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_decisions",
      description: "Recent agent decision-log entries (newest first).",
      parameters: { type: "object", properties: { limit: { type: "number" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "open_position",
      description: "Open an LP position on a pool. DRY_RUN-aware (builds & validates, broadcasts only if DRY_RUN=false). Amounts are human units.",
      parameters: {
        type: "object",
        properties: {
          pool: { type: "string" },
          amountX: { type: "number", description: "amount of tokenX (base)" },
          amountY: { type: "number", description: "amount of tokenY (quote)" },
          strategy: { type: "string", enum: ["spot", "curve", "bid_ask"] },
          binsBelow: { type: "number" },
          binsAbove: { type: "number" },
        },
        required: ["pool"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_position",
      description: "Close (remove liquidity from) a position by id/pool/index. DRY_RUN-aware.",
      parameters: {
        type: "object",
        properties: { position: { type: "string" } },
        required: ["position"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_screen_cycle",
      description: "Run one screening cycle: rank, drop already-held, optionally auto-open the top pick.",
      parameters: {
        type: "object",
        properties: {
          deploy: { type: "boolean" },
          amountX: { type: "number" },
          amountY: { type: "number" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_manage_cycle",
      description: "Run one management cycle: evaluate every open position against exit rules and act (DRY_RUN-aware).",
      parameters: {
        type: "object",
        properties: { execute: { type: "boolean", description: "default true; false = evaluate only" } },
      },
    },
  },
];

const SCREENER_TOOLS = new Set([
  "get_candidates", "get_pool_detail", "get_balances", "get_positions",
  "run_screen_cycle", "open_position", "get_decisions",
]);
const MANAGER_TOOLS = new Set([
  "get_positions", "get_position_pnl", "run_manage_cycle", "close_position",
  "get_balances", "get_decisions",
]);

export function toolsForRole(role: Role): ToolDef[] {
  if (role === "GENERAL") return ALL_TOOLS;
  const allow = role === "SCREENER" ? SCREENER_TOOLS : MANAGER_TOOLS;
  return ALL_TOOLS.filter((t) => allow.has(t.function.name));
}

// ─── executor ────────────────────────────────────────────────────────
export async function executeTool(name: string, argsJson: string): Promise<string> {
  let args: any = {};
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return safeJson({ error: `invalid JSON arguments for ${name}` });
  }
  log.info("agent", `→ ${name}(${argsJson || ""})`);
  try {
    switch (name) {
      case "get_candidates":
        return safeJson(await getTopCandidates({ limit: args.limit ?? 10 }));
      case "get_pool_detail":
        return safeJson(await getPoolDetail(String(args.pool)));
      case "get_positions":
        return safeJson(getOpenPositions());
      case "get_position_pnl": {
        if (args.position) {
          const p = resolvePosition(String(args.position));
          if (!p) return safeJson({ error: "position not found" });
          return safeJson(await computePositionPnl(p));
        }
        const all = getOpenPositions();
        return safeJson(await Promise.all(all.map((p) => computePositionPnl(p))));
      }
      case "get_balances":
        return safeJson(await getBalances([WMON]));
      case "get_decisions":
        return safeJson(getRecentDecisions(args.limit ?? 20));
      case "open_position":
        return safeJson(
          await openPosition({
            pool: String(args.pool),
            amountX: Number(args.amountX ?? 0),
            amountY: Number(args.amountY ?? 0),
            strategy: args.strategy as Strategy | undefined,
            binsBelow: args.binsBelow,
            binsAbove: args.binsAbove,
          }),
        );
      case "close_position": {
        const p = resolvePosition(String(args.position));
        if (!p) return safeJson({ error: "position not found" });
        return safeJson(await closePosition(p));
      }
      case "run_screen_cycle":
        return safeJson(
          await runScreenCycle({ deploy: Boolean(args.deploy), amountX: args.amountX, amountY: args.amountY }),
        );
      case "run_manage_cycle":
        return safeJson(await runManageCycle({ execute: args.execute ?? true }));
      default:
        return safeJson({ error: `unknown tool ${name}` });
    }
  } catch (e) {
    return safeJson({ error: (e as Error).message });
  }
}
