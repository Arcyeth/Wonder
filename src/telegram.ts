/**
 * Telegram control — notifications + a command bot. Provider-agnostic via the
 * Bot API over fetch (no SDK). Degrades to a no-op when no token is set, so the
 * daemon and CLI work fine without Telegram.
 *
 * `handleCommand` is pure-ish (returns reply text) and unit-testable without a
 * token; `startTelegram` adds the long-poll loop and auth.
 */
import { config } from "./config";
import { assertChain } from "./chain/client";
import { getOpenPositions, resolvePosition } from "./state";
import { computePositionPnl } from "./data/pnl";
import { closePosition } from "./chain/lb-write";
import { recordClose } from "./lessons";
import { runScreenCycle } from "./screen-cycle";
import { runManageCycle } from "./manage";
import { getLessons, getPerformanceSummary } from "./lessons";
import { fmtUsd, fmtPct } from "./util/num";
import { log } from "./util/log";

const API = (token: string) => `https://api.telegram.org/bot${token}`;

export function telegramAvailable(): boolean {
  return Boolean(config.telegram.token);
}

export async function sendMessage(text: string, chatId?: string): Promise<void> {
  const { token } = config.telegram;
  const to = chatId || config.telegram.chatId;
  if (!token || !to) return; // graceful no-op
  try {
    await fetch(`${API(token)}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: to, text, disable_web_page_preview: true }),
    });
  } catch (e) {
    log.warn("telegram", `sendMessage failed: ${(e as Error).message}`);
  }
}

/** Fire-and-forget notification to the configured chat (autonomous events). */
export function notify(text: string): void {
  if (!telegramAvailable() || !config.telegram.chatId) return;
  void sendMessage(text);
}

const HELP = [
  "Wonder commands:",
  "/status — mode, open positions, performance",
  "/positions — list open positions",
  "/pnl — on-chain PnL of open positions",
  "/screen — rank candidates (no deploy)",
  "/manage — evaluate & act on positions",
  "/close <id|pool|index> — close a position",
  "/lessons — what Wonder learned",
  "/performance — win rate / avg PnL",
].join("\n");

/** Dispatch a single command string → reply text. Token-free, testable. */
export async function handleCommand(text: string): Promise<string> {
  const parts = text.trim().split(/\s+/);
  const cmd = (parts[0] || "").toLowerCase().replace(/@.*$/, "");
  const arg = parts[1];

  switch (cmd) {
    case "/help":
    case "/start":
      return HELP;

    case "/status": {
      const open = getOpenPositions();
      const perf = getPerformanceSummary();
      return [
        `Mode: ${config.wallet.dryRun ? "DRY_RUN" : "LIVE"}`,
        `Open positions: ${open.length}/${config.management.maxPositions}`,
        `Closes: ${perf.closes} (win ${perf.winRatePct != null ? perf.winRatePct.toFixed(0) + "%" : "—"}, avg ${perf.avgPnlPct != null ? perf.avgPnlPct.toFixed(1) + "%" : "—"})`,
      ].join("\n");
    }

    case "/positions": {
      const open = getOpenPositions();
      if (!open.length) return "No open positions.";
      return open
        .map((p, i) => `${i + 1}. ${p.name} ${p.strategy} bins ${p.binIds.length} ≈${fmtUsd(p.depositValueUsd)}${p.dryRun ? " (dry)" : ""}`)
        .join("\n");
    }

    case "/pnl": {
      await assertChain();
      const open = getOpenPositions();
      if (!open.length) return "No open positions.";
      const lines: string[] = [];
      for (const p of open) {
        const pnl = await computePositionPnl(p);
        lines.push(
          pnl.hasOnchainLiquidity
            ? `${p.name}: ${fmtUsd(pnl.currentValueUsd)} (${pnl.pnlPct != null ? fmtPct(pnl.pnlPct) : "—"})`
            : `${p.name}: no on-chain liquidity`,
        );
      }
      return lines.join("\n");
    }

    case "/screen": {
      await assertChain();
      const r = await runScreenCycle({ deploy: false });
      return r.picked ? `Top pick: ${r.picked.name} (score ${r.picked.score.toFixed(0)}, TVL ${fmtUsd(r.picked.tvlUsd)})` : `No pick: ${r.reason}`;
    }

    case "/manage": {
      await assertChain();
      const r = await runManageCycle({ execute: true });
      return `Manage: evaluated ${r.evaluated}, closed ${r.closed}, stayed ${r.stayed}.`;
    }

    case "/close": {
      if (!arg) return "Usage: /close <id|pool|index>";
      const p = resolvePosition(arg);
      if (!p) return `No open position matching "${arg}".`;
      await assertChain();
      const pnl = await computePositionPnl(p);
      const res = await closePosition(p);
      recordClose(p, pnl, "telegram close");
      return `Close ${p.name}: ${res.note}`;
    }

    case "/lessons": {
      const lessons = getLessons();
      return lessons.length ? lessons.map((l) => `${l.kind}: ${l.text}`).join("\n") : "No lessons yet.";
    }

    case "/performance": {
      const perf = getPerformanceSummary();
      return `Closes ${perf.closes}, evaluated ${perf.evaluated}, win ${perf.winRatePct != null ? perf.winRatePct.toFixed(0) + "%" : "—"}, avg ${perf.avgPnlPct != null ? perf.avgPnlPct.toFixed(2) + "%" : "—"}`;
    }

    default:
      return cmd.startsWith("/") ? `Unknown command ${cmd}. /help for the list.` : "";
  }
}

function isAuthorized(msg: any): boolean {
  const { chatId, allowedUserIds } = config.telegram;
  const fromChat = String(msg?.chat?.id ?? "");
  const fromUser = String(msg?.from?.id ?? "");
  if (chatId && fromChat !== chatId) return false;
  if (allowedUserIds.length && !allowedUserIds.includes(fromUser)) return false;
  if (!chatId && !allowedUserIds.length) {
    log.warn("telegram", "no chatId/allowedUserIds set — accepting all senders (set them to lock down)");
  }
  return true;
}

/** Long-poll the Bot API and dispatch authorized commands. Runs until killed. */
export async function startTelegram(): Promise<void> {
  const { token } = config.telegram;
  if (!token) {
    log.warn("telegram", "no TELEGRAM_BOT_TOKEN — control bot disabled.");
    return;
  }
  log.info("telegram", "control bot polling…");
  let offset = 0;
  for (;;) {
    try {
      const res = await fetch(`${API(token)}/getUpdates?timeout=30&offset=${offset}`);
      const data: any = await res.json();
      for (const upd of data?.result ?? []) {
        offset = upd.update_id + 1;
        const msg = upd.message;
        const text: string = msg?.text ?? "";
        if (!text.startsWith("/")) continue;
        if (!isAuthorized(msg)) {
          log.warn("telegram", `unauthorized message from chat ${msg?.chat?.id}`);
          continue;
        }
        try {
          const reply = await handleCommand(text);
          if (reply) await sendMessage(reply, String(msg.chat.id));
        } catch (e) {
          await sendMessage(`error: ${(e as Error).message}`, String(msg.chat.id));
        }
      }
    } catch (e) {
      log.warn("telegram", `poll error: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
