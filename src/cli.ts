#!/usr/bin/env -S npx tsx
/**
 * Wonder CLI — Phase 1 (read-only screening; NO transactions).
 *
 *   npm run candidates -- [--limit N] [--timeframe h24|h6|h1|m5] [--json]
 *   npm run pool-detail -- --pool 0x...
 *   npm run pairs                       # list all LFJ LBPairs + basic metrics
 *
 * Or directly:  npx tsx src/cli.ts <command> [flags]
 */
import { ethers } from "ethers";
import { config } from "./config";
import { assertChain } from "./chain/client";
import { getAllLbPairAddresses } from "./chain/lb";
import { getPairsByAddresses } from "./data/dexscreener";
import { getTopCandidates, getPoolDetail } from "./screening";
import { getBalances, walletAddress } from "./chain/wallet";
import { openPosition, closePosition } from "./chain/lb-write";
import { computePositionPnl } from "./data/pnl";
import { getOpenPositions, resolvePosition, type Position } from "./state";
import { runScreenCycle } from "./screen-cycle";
import { runManageCycle } from "./manage";
import { getRecentDecisions } from "./decision-log";
import { runAgent } from "./agent/loop";
import { llmAvailable } from "./llm";
import type { Role } from "./agent/tools";
import { recordClose, getLessons, getPerformanceSummary } from "./lessons";
import { runDaemon } from "./daemon";
import { fmtUsd, fmtPct } from "./util/num";
import { EXPLORER_URL, CHAIN_ID, NATIVE_SYMBOL, WMON } from "./constants";
import type { Candidate, Strategy } from "./types";

// ─── arg parsing ─────────────────────────────────────────────────────
function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length) args._goal = positionals.join(" ");
  return args;
}

const short = (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const secBadge = (c: Candidate): string => {
  const sec = c.security;
  if (!sec) return "·";
  if (sec.isHoneypot === true) return "🍯HONEYPOT";
  const flags: string[] = [];
  if ((sec.buyTaxPct ?? 0) > 0 || (sec.sellTaxPct ?? 0) > 0)
    flags.push(`tax${sec.buyTaxPct ?? 0}/${sec.sellTaxPct ?? 0}`);
  if (sec.top10HolderPct != null) flags.push(`top10 ${sec.top10HolderPct.toFixed(0)}%`);
  if (sec.isMintable === true) flags.push("mintable");
  if (sec.isOpenSource === false) flags.push("closed-src");
  return flags.length ? flags.join(" ") : "ok";
};

// ─── commands ────────────────────────────────────────────────────────
async function cmdCandidates(args: Record<string, string | boolean>) {
  if (args.timeframe) config.screening.timeframe = String(args.timeframe) as any;
  const limit = args.limit ? Number(args.limit) : 10;
  await assertChain();
  const result = await getTopCandidates({ limit });

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  const tf = config.screening.timeframe;
  console.log(`\n🌊 Wonder — LFJ Liquidity Book candidates on Monad (chainId ${CHAIN_ID}, window=${tf})\n`);
  if (result.candidates.length === 0) {
    console.log("No candidates passed the filters.");
  } else {
    console.log(
      [
        "#".padEnd(3),
        "PAIR".padEnd(18),
        "binStp".padEnd(7),
        "fee%".padEnd(7),
        "TVL".padEnd(9),
        `vol(${tf})`.padEnd(10),
        "feeTvl".padEnd(8),
        "hold".padEnd(6),
        "mcap".padEnd(9),
        "org".padEnd(4),
        "score".padEnd(8),
        "security",
      ].join(" "),
    );
    console.log("─".repeat(120));
    result.candidates.forEach((c, i) => {
      console.log(
        [
          String(i + 1).padEnd(3),
          (c.name || "?").slice(0, 17).padEnd(18),
          String(c.binStep ?? "—").padEnd(7),
          (c.feePct != null ? c.feePct.toFixed(3) : "—").padEnd(7),
          fmtUsd(c.tvlUsd).padEnd(9),
          fmtUsd(c.volumeWindow).padEnd(10),
          (c.feeTvlRatio != null ? c.feeTvlRatio.toFixed(4) : "—").padEnd(8),
          String(c.holders ?? "—").padEnd(6),
          fmtUsd(c.mcap).padEnd(9),
          String(c.organicProxy).padEnd(4),
          c.score.toFixed(1).padEnd(8),
          secBadge(c),
        ].join(" "),
      );
    });
    console.log("\nPools (full address):");
    result.candidates.forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.name.padEnd(18)} ${c.pool}  ${EXPLORER_URL}/address/${c.pool}`);
    });
  }

  console.log(`\nScreened ${result.totalScreened} enriched pool(s).`);
  if (result.filteredExamples.length) {
    console.log("Sample of filtered-out pools:");
    for (const f of result.filteredExamples) console.log(`  · ${f.name}: ${f.reason}`);
  }
  console.log(
    "\n⚠️  Phase 1 = read-only screening. Numbers are snapshots; organicProxy is synthesized (no Jupiter equiv on Monad). No transactions are sent.\n",
  );
}

async function cmdPoolDetail(args: Record<string, string | boolean>) {
  const pool = args.pool ? String(args.pool) : "";
  if (!pool) {
    console.error("Usage: pool-detail --pool 0x<LBPair address>");
    process.exit(1);
  }
  if (args.timeframe) config.screening.timeframe = String(args.timeframe) as any;
  await assertChain();
  const { candidate, onchain, dex, security } = await getPoolDetail(pool);

  if (args.json) {
    process.stdout.write(JSON.stringify({ candidate, onchain: serializeOnchain(onchain), dex, security }, null, 2) + "\n");
    return;
  }

  if (!candidate && !onchain) {
    console.log(`No data found for ${pool} (not an LFJ LBPair, or no market data).`);
    return;
  }
  console.log(`\n🔎 Pool detail — ${candidate?.name ?? short(pool)}\n`);
  console.log(`  LBPair      : ${pool}`);
  console.log(`  Explorer    : ${EXPLORER_URL}/address/${pool}`);
  if (onchain) {
    console.log(`  Tokens      : ${onchain.symbolX} (X) / ${onchain.symbolY} (Y)`);
    console.log(`  binStep     : ${onchain.binStep} bps`);
    console.log(`  activeId    : ${onchain.activeId}`);
    console.log(`  base fee    : ${onchain.baseFeePct.toFixed(4)}%`);
    console.log(`  price X→Y   : ${onchain.priceXinY}`);
    console.log(`  reserves    : ${onchain.reserveX} X / ${onchain.reserveY} Y (raw)`);
  }
  if (dex) {
    console.log(`  priceUsd    : ${dex.priceUsd ?? "—"}`);
    console.log(`  TVL (liq)   : ${fmtUsd(dex.liquidityUsd)}`);
    console.log(`  volume 24h  : ${fmtUsd(dex.volume.h24)}`);
    console.log(`  mcap / fdv  : ${fmtUsd(dex.marketCap)} / ${fmtUsd(dex.fdv)}`);
    console.log(`  priceChange : 24h ${fmtPct(dex.priceChange.h24)} | 1h ${fmtPct(dex.priceChange.h1)}`);
    console.log(`  dexId       : ${dex.dexId}${dex.labels.length ? ` [${dex.labels.join(",")}]` : ""}`);
  }
  if (candidate) {
    console.log(`  feeTvlRatio : ${candidate.feeTvlRatio ?? "—"} (window ${candidate.timeframe})`);
    console.log(`  organicProxy: ${candidate.organicProxy}/100`);
    console.log(`  score       : ${candidate.score.toFixed(1)}`);
  }
  if (security) {
    console.log("\n  Security (GoPlus):");
    console.log(`    holders   : ${security.holderCount ?? "—"}`);
    console.log(`    honeypot  : ${security.isHoneypot ?? "unknown"}`);
    console.log(`    tax buy/sell: ${security.buyTaxPct ?? "—"}% / ${security.sellTaxPct ?? "—"}%`);
    console.log(`    top10 hold: ${security.top10HolderPct != null ? security.top10HolderPct.toFixed(1) + "%" : "—"}`);
    console.log(`    open src  : ${security.isOpenSource ?? "—"} | proxy: ${security.isProxy ?? "—"} | mintable: ${security.isMintable ?? "—"}`);
  } else {
    console.log("\n  Security (GoPlus): no data (chain/token unindexed).");
  }
  console.log();
}

async function cmdPairs() {
  await assertChain();
  const addresses = await getAllLbPairAddresses();
  const dexMap = await getPairsByAddresses(addresses);
  console.log(`\n📋 ${addresses.length} LFJ LBPair(s) on Monad\n`);
  addresses.forEach((addr, i) => {
    const d = dexMap.get(addr.toLowerCase());
    const label = d ? `${d.baseToken.symbol}-${d.quoteToken.symbol}` : "(no market data)";
    const tvl = d ? fmtUsd(d.liquidityUsd) : "—";
    const vol = d ? fmtUsd(d.volume.h24) : "—";
    console.log(`  ${String(i + 1).padEnd(3)} ${label.slice(0, 20).padEnd(21)} TVL ${tvl.padEnd(9)} vol24h ${vol.padEnd(9)} ${addr}`);
  });
  console.log();
}

function serializeOnchain(oc: any) {
  if (!oc) return null;
  return { ...oc, reserveX: oc.reserveX?.toString?.() ?? oc.reserveX, reserveY: oc.reserveY?.toString?.() ?? oc.reserveY };
}

async function cmdBalance() {
  await assertChain();
  const open = getOpenPositions();
  const tokens = [...new Set([WMON, ...open.flatMap((p) => [p.tokenX, p.tokenY])])];
  const { address, native, tokens: bals } = await getBalances(tokens);
  if (!address) {
    console.log("\nNo WALLET_PRIVATE_KEY set (keyless dry-run). Balances unavailable.\n");
    return;
  }
  console.log(`\n💰 Wallet ${address}\n`);
  console.log(`  ${native.toFixed(5)} ${NATIVE_SYMBOL} (native)`);
  for (const b of bals) console.log(`  ${b.human.toFixed(5)} ${b.symbol}  (${b.token})`);
  console.log();
}

async function cmdOpen(args: Record<string, string | boolean>) {
  const pool = args.pool ? String(args.pool) : "";
  if (!pool) {
    console.error("Usage: open --pool 0x... [--amount-x N] [--amount-y N] [--strategy spot|curve|bid_ask] [--bins-below N] [--bins-above N]");
    process.exit(1);
  }
  await assertChain();
  const amountX = args["amount-x"] != null ? Number(args["amount-x"]) : config.management.deployAmountX;
  const amountY = args["amount-y"] != null ? Number(args["amount-y"]) : config.management.deployAmountY;
  const strategy = (args.strategy ? String(args.strategy) : config.management.strategy) as Strategy;
  const binsBelow = args["bins-below"] != null ? Number(args["bins-below"]) : undefined;
  const binsAbove = args["bins-above"] != null ? Number(args["bins-above"]) : undefined;

  const res = await openPosition({ pool, amountX, amountY, strategy, binsBelow, binsAbove });
  if (args.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  const p = res.position;
  const mode = res.dryRun ? "🧪 DRY_RUN" : "🚀 LIVE";
  console.log(`\n${mode} open — ${p.name}  (${p.strategy})\n`);
  console.log(`  Pool        : ${p.pool}`);
  console.log(`  binStep     : ${p.binStep} | activeId ${p.activeIdAtDeploy}`);
  console.log(`  Range       : bins ${Math.min(...p.binIds)}..${Math.max(...p.binIds)} (${p.binIds.length} bins, Δ ${Math.min(...p.deltaIds)}..${Math.max(...p.deltaIds)})`);
  console.log(`  Deposit     : ${p.amountXHuman} ${p.symbolX} + ${p.amountYHuman} ${p.symbolY}  ≈ ${fmtUsd(p.depositValueUsd)}`);
  console.log(`  Encoding    : ${res.encodedOk ? "valid ✓" : "INVALID ✗"} (addLiquidity)`);
  // Per-bin allocation preview (first 3 + last 3).
  const fmtBin = (b: { id: number; deltaId: number; amountX: string; amountY: string }) =>
    `    Δ${String(b.deltaId).padStart(3)} (id ${b.id}): ${ethers.formatUnits(b.amountX, p.decimalsX)} ${p.symbolX} / ${ethers.formatUnits(b.amountY, p.decimalsY)} ${p.symbolY}`;
  console.log("  Allocation  :");
  const preview = res.perBin.length <= 6 ? res.perBin : [...res.perBin.slice(0, 3), null, ...res.perBin.slice(-3)];
  for (const b of preview) console.log(b ? fmtBin(b) : "      …");
  console.log(`\n  ${res.note}`);
  console.log(`  Position id : ${p.id}\n`);
}

async function cmdPositions(args: Record<string, string | boolean>) {
  const open = getOpenPositions();
  if (args.json) {
    process.stdout.write(JSON.stringify(open, null, 2) + "\n");
    return;
  }
  console.log(`\n📌 ${open.length} open position(s)\n`);
  if (open.length === 0) {
    console.log("  (none) — open one with:  npm run open -- --pool 0x... --amount-y 5\n");
    return;
  }
  open.forEach((p, i) => {
    const range = `${Math.min(...p.binIds)}..${Math.max(...p.binIds)}`;
    console.log(
      `  ${String(i + 1).padEnd(3)} ${p.name.padEnd(14)} ${p.strategy.padEnd(8)} binStep ${String(p.binStep).padEnd(4)} bins ${range.padEnd(20)} ${fmtUsd(p.depositValueUsd).padEnd(9)} ${p.dryRun ? "🧪dry" : "live"}`,
    );
    console.log(`        id=${p.id}`);
  });
  console.log();
}

async function cmdPnl(args: Record<string, string | boolean>) {
  await assertChain();
  const targets: Position[] = args.position
    ? [resolvePosition(String(args.position))].filter((x): x is Position => x != null)
    : getOpenPositions();
  if (targets.length === 0) {
    console.log("\nNo matching open position(s).\n");
    return;
  }
  if (!walletAddress()) {
    console.log("\n⚠️  No WALLET_PRIVATE_KEY — on-chain PnL needs the position owner address. Showing deposit only.\n");
  }
  const results = [];
  for (const p of targets) {
    const pnl = await computePositionPnl(p);
    results.push({ name: p.name, ...pnl });
  }
  if (args.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    return;
  }
  console.log(`\n📈 PnL\n`);
  for (const r of results) {
    console.log(`  ${r.name}  (${r.positionId})`);
    if (!r.hasOnchainLiquidity) {
      console.log(`    no on-chain liquidity (simulated/dry or closed). deposit ≈ ${fmtUsd(r.depositValueUsd)}\n`);
      continue;
    }
    console.log(`    holdings  : ${r.currentXHuman.toFixed(4)} X + ${r.currentYHuman.toFixed(4)} Y across ${r.binsWithLiquidity} bin(s)`);
    console.log(`    value     : ${fmtUsd(r.currentValueUsd)}  (deposit ${fmtUsd(r.depositValueUsd)})`);
    console.log(`    PnL       : ${fmtUsd(r.pnlUsd)}  ${r.pnlPct != null ? fmtPct(r.pnlPct) : ""}`);
    console.log(`    in range  : ${r.inRange ?? "unknown"}\n`);
  }
}

async function cmdClose(args: Record<string, string | boolean>) {
  const ref = args.position ? String(args.position) : "";
  if (!ref) {
    console.error("Usage: close --position <id|poolAddress|index>");
    process.exit(1);
  }
  const p = resolvePosition(ref);
  if (!p) {
    console.log(`No open position matching "${ref}".`);
    return;
  }
  await assertChain();
  const pnl = await computePositionPnl(p); // capture before liquidity is removed
  const res = await closePosition(p);
  recordClose(p, pnl, "manual close");
  if (args.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }
  const mode = res.dryRun ? "🧪 DRY_RUN" : "🚀 LIVE";
  console.log(`\n${mode} close — ${p.name} (${res.positionId})\n`);
  console.log(`  Bins burned : ${res.ids.length}${res.hasOnchainLiquidity ? "" : " (no on-chain balance)"}`);
  console.log(`  Encoding    : ${res.encodedOk ? "valid ✓" : "INVALID ✗"} (removeLiquidity)`);
  console.log(`  ${res.note}\n`);
}

async function cmdScreen(args: Record<string, string | boolean>) {
  await assertChain();
  const deploy = Boolean(args.deploy);
  const limit = args.limit != null ? Number(args.limit) : 10;
  const amountX = args["amount-x"] != null ? Number(args["amount-x"]) : undefined;
  const amountY = args["amount-y"] != null ? Number(args["amount-y"]) : undefined;
  const res = await runScreenCycle({ deploy, amountX, amountY, limit });
  if (args.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }
  console.log(`\n🔁 Screen cycle — ${config.wallet.dryRun ? "DRY_RUN" : "LIVE"}\n`);
  if (!res.picked) {
    console.log(`  No deploy: ${res.reason}\n`);
    return;
  }
  const p = res.picked;
  console.log(`  Pick    : ${p.name}  (score ${p.score.toFixed(1)}, binStep ${p.binStep}, TVL ${fmtUsd(p.tvlUsd)})`);
  console.log(`  Pool    : ${p.pool}`);
  if (res.deployed && res.openResult) {
    console.log(`  Deployed: ${res.openResult.position.binIds.length} bins ≈ ${fmtUsd(res.openResult.position.depositValueUsd)}`);
    console.log(`  ${res.openResult.note}`);
    console.log(`  Position: ${res.openResult.position.id}`);
  } else {
    console.log(`  Action  : ${res.reason}`);
    console.log(`  (run with --deploy --amount-y <n> to open)`);
  }
  console.log();
}

async function cmdManage(args: Record<string, string | boolean>) {
  await assertChain();
  const execute = !args["no-execute"];
  const res = await runManageCycle({ execute });
  if (args.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }
  console.log(`\n🛠️  Manage cycle — ${config.wallet.dryRun ? "DRY_RUN" : "LIVE"}${execute ? "" : " (evaluate-only)"}\n`);
  if (!res.walletPresent) {
    console.log("  ⚠️  No WALLET_PRIVATE_KEY — on-chain PnL can't be read, so positions can't be evaluated.\n");
  }
  if (res.evaluated === 0) {
    console.log("  No open positions.\n");
    return;
  }
  for (const o of res.outcomes) {
    const tag = o.action.kind === "CLOSE" ? "🔴 CLOSE" : "🟢 STAY";
    const pnl = o.pnl.pnlPct != null ? fmtPct(o.pnl.pnlPct) : "n/a";
    console.log(`  ${tag}  ${o.position.name.padEnd(14)} pnl ${pnl.padEnd(8)} — ${o.action.reason}`);
    if (o.executed) console.log(`         ↳ ${o.note}`);
  }
  console.log(`\n  Evaluated ${res.evaluated}, closed ${res.closed}, stayed ${res.stayed}.\n`);
}

function cmdDecisions(args: Record<string, string | boolean>) {
  const limit = args.limit != null ? Number(args.limit) : 20;
  const decisions = getRecentDecisions(limit);
  if (args.json) {
    process.stdout.write(JSON.stringify(decisions, null, 2) + "\n");
    return;
  }
  console.log(`\n🧾 Recent decisions (${decisions.length})\n`);
  if (decisions.length === 0) {
    console.log("  (none yet — run `screen` or `manage`)\n");
    return;
  }
  for (const d of decisions) {
    const when = new Date(d.ts).toISOString().slice(5, 16).replace("T", " ");
    console.log(`  ${when}  [${d.actor}] ${d.type.padEnd(13)} ${d.name ?? "—"}`);
    console.log(`            ${d.reason}`);
  }
  console.log();
}

async function cmdAgent(args: Record<string, string | boolean>) {
  const goal = String(args.goal || args._goal || "").trim();
  if (!goal) {
    console.error('Usage: agent "<goal>" [--role screener|manager|general]');
    process.exit(1);
  }
  const roleArg = String(args.role || "general").toUpperCase();
  const role = (["SCREENER", "MANAGER", "GENERAL"].includes(roleArg) ? roleArg : "GENERAL") as Role;

  if (!llmAvailable()) {
    console.log(
      "\n⚠️  No LLM configured. Set LLM_API_KEY (or OPENROUTER_API_KEY) in .env,\n" +
        "    or LLM_BASE_URL to a local endpoint (e.g. http://localhost:1234/v1),\n" +
        "    then optionally LLM_MODEL. The deterministic `screen` / `manage` cycles work without an LLM.\n",
    );
    process.exit(1);
  }

  await assertChain();
  console.log(`\n🤖 Agent [${role}] — ${config.wallet.dryRun ? "DRY_RUN" : "LIVE"}\n   goal: ${goal}\n`);
  const res = await runAgent({ goal, role });
  if (args.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }
  if (res.toolCalls.length) {
    console.log("   tools used: " + res.toolCalls.map((t) => t.name).join(" → "));
  }
  console.log(`\n${res.finalText}\n\n   (${res.steps} step${res.steps === 1 ? "" : "s"})\n`);
}

async function cmdStart(args: Record<string, string | boolean>) {
  await runDaemon({ once: Boolean(args.once), deploy: Boolean(args.deploy) });
}

function cmdLessons(args: Record<string, string | boolean>) {
  const lessons = getLessons();
  const perf = getPerformanceSummary();
  if (args.json) {
    process.stdout.write(JSON.stringify({ summary: perf, lessons }, null, 2) + "\n");
    return;
  }
  console.log(`\n📚 Lessons (${lessons.length})\n`);
  if (lessons.length === 0) console.log("  (none yet — lessons accrue as positions close)");
  for (const l of lessons) console.log(`  ${l.kind.padEnd(7)} ${l.text}`);
  console.log(`\n  Performance: ${perf.closes} closes, ${perf.evaluated} evaluated, win ${perf.winRatePct != null ? perf.winRatePct.toFixed(0) + "%" : "—"}, avg ${perf.avgPnlPct != null ? perf.avgPnlPct.toFixed(1) + "%" : "—"}\n`);
}

function cmdPerformance(args: Record<string, string | boolean>) {
  const perf = getPerformanceSummary();
  if (args.json) {
    process.stdout.write(JSON.stringify(perf, null, 2) + "\n");
    return;
  }
  console.log(`\n📊 Performance\n`);
  console.log(`  closes      : ${perf.closes}`);
  console.log(`  evaluated   : ${perf.evaluated} (with on-chain PnL)`);
  console.log(`  wins        : ${perf.wins}`);
  console.log(`  win rate    : ${perf.winRatePct != null ? perf.winRatePct.toFixed(1) + "%" : "—"}`);
  console.log(`  avg PnL     : ${perf.avgPnlPct != null ? perf.avgPnlPct.toFixed(2) + "%" : "—"}\n`);
}

function help() {
  console.log(`
Wonder CLI — LFJ/Monad DLMM agent

Screening (Phase 1, read-only):
  candidates [--limit N] [--timeframe h24|h6|h1|m5] [--json]   Rank LP candidates
  pool-detail --pool 0x... [--timeframe ..] [--json]            Deep dive one pool
  pairs                                                         List all LFJ LBPairs

Lifecycle (Phase 2, DRY_RUN by default — set DRY_RUN=false to broadcast):
  balance                                                      Wallet MON + token balances
  open --pool 0x... [--amount-x N] [--amount-y N]
       [--strategy spot|curve|bid_ask] [--bins-below N] [--bins-above N] [--json]
                                                               Build & record an LP position
  positions [--json]                                           List open positions
  pnl [--position <id|pool|index>] [--json]                    On-chain PnL of position(s)
  close --position <id|pool|index> [--json]                    Remove liquidity / close

Agent cycles (Phase 3, deterministic; DRY_RUN by default):
  screen [--deploy] [--amount-x N] [--amount-y N] [--limit N] [--json]
                                                               Rank + (optionally) auto-open top pick
  manage [--no-execute] [--json]                               Evaluate open positions & close per rules
  decisions [--limit N] [--json]                               Recent agent decision log

LLM agent (Phase 3b; needs LLM_API_KEY or a local LLM_BASE_URL):
  agent "<goal>" [--role screener|manager|general] [--json]    ReAct agent over all tools

Autonomous runtime + learning (Phase 4):
  start [--once] [--deploy]                                    Run the daemon (manage + screen loops)
  lessons [--json]                                             Lessons learned from closed positions
  performance [--json]                                         Win rate / avg PnL summary

  help                                                         This message

Phase 1 needs no key. Phases 2–3 build & validate txs in DRY_RUN without a key;
broadcasting (DRY_RUN=false) requires WALLET_PRIVATE_KEY and funds.
The LLM agent additionally needs an OpenAI-compatible endpoint (OpenRouter/local).
`);
}

// ─── entry ───────────────────────────────────────────────────────────
async function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);
  try {
    switch (command) {
      case "candidates":
        await cmdCandidates(args);
        break;
      case "pool-detail":
        await cmdPoolDetail(args);
        break;
      case "pairs":
        await cmdPairs();
        break;
      case "balance":
        await cmdBalance();
        break;
      case "open":
        await cmdOpen(args);
        break;
      case "positions":
        await cmdPositions(args);
        break;
      case "pnl":
        await cmdPnl(args);
        break;
      case "close":
        await cmdClose(args);
        break;
      case "screen":
        await cmdScreen(args);
        break;
      case "manage":
        await cmdManage(args);
        break;
      case "decisions":
        cmdDecisions(args);
        break;
      case "agent":
        await cmdAgent(args);
        break;
      case "start":
        await cmdStart(args);
        break;
      case "lessons":
        cmdLessons(args);
        break;
      case "performance":
        cmdPerformance(args);
        break;
      case "help":
      case undefined:
        help();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        help();
        process.exit(1);
    }
  } catch (e) {
    console.error(`\n✖ ${(e as Error).message}\n`);
    process.exit(1);
  }
}

main();
