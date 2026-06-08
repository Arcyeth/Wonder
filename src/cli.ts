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
import { config } from "./config";
import { assertChain } from "./chain/client";
import { getAllLbPairAddresses } from "./chain/lb";
import { getPairsByAddresses } from "./data/dexscreener";
import { getTopCandidates, getPoolDetail } from "./screening";
import { fmtUsd, fmtPct } from "./util/num";
import { EXPLORER_URL, CHAIN_ID } from "./constants";
import type { Candidate } from "./types";

// ─── arg parsing ─────────────────────────────────────────────────────
function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
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
    }
  }
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

function help() {
  console.log(`
Wonder CLI — Phase 1 (read-only LFJ/Monad DLMM screening)

Commands:
  candidates [--limit N] [--timeframe h24|h6|h1|m5] [--json]   Rank LP candidates
  pool-detail --pool 0x... [--timeframe ..] [--json]            Deep dive one pool
  pairs                                                         List all LFJ LBPairs
  help                                                          This message

No private key needed. No transactions are ever sent in Phase 1.
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
