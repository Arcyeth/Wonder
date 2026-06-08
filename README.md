# Wonder

**Autonomous DLMM / LP agent for [LFJ Liquidity Book](https://lfj.gg) (DLMM) on [Monad](https://monad.xyz).**

Wonder screens pools, opens / manages / closes LP positions, learns from past trades,
and is controllable from CLI or Telegram with configurable risk settings — the same
concept as [Meridian](https://github.com/yunus-0x/meridian) (Solana/Meteora), rebuilt
natively for Monad + LFJ.

> **Status: Phase 1 — read-only screening.** No private key, no transactions.
> Position management, the LLM agent loop, and Telegram control land in later phases.

---

## Why Monad + LFJ

- **LFJ Liquidity Book** is a true DLMM (bin-based dynamic liquidity, the Trader Joe
  model that also inspired Meteora) — so Meridian's bin/strategy concepts map ~1:1.
- **Monad** is an EVM L1 (chainId `143`) with ~400 ms blocks / ~800 ms finality, ideal
  for high-frequency LP management.

LFJ v2.2 (the live DLMM) on Monad mainnet:

| Contract  | Address |
|-----------|---------|
| LBFactory | `0xb43120c4745967fa9b93E79C149E66B0f2D6Fe0c` |
| LBRouter  | `0x18556DA13313f3532c54711497A8FedAC273220E` |

## Architecture (Phase 1)

```
src/
  constants.ts        Monad/LFJ addresses, chainId, API endpoints
  config.ts           .env + user-config.json → config (thresholds calibrated for Monad)
  types.ts            shared types
  chain/
    client.ts         ethers v6 provider (Monad mainnet, staticNetwork)
    abis.ts           minimal LBFactory / LBPair / ERC20 ABIs
    lb.ts             LFJ LB reader: enumerate pairs, read binStep/activeId/reserves/fee, price
  data/
    dexscreener.ts    TVL / volume / mcap / price (chain "monad", dexId "traderjoe")
    goplus.ts         token security: honeypot / holders / tax / top-10 concentration
  screening.ts        discover → pre-filter → enrich → hard-filter → score → rank
  cli.ts              candidates / pool-detail / pairs
```

**Data sources** (Solana equivalents → Monad):
Meteora screening API → on-chain `LBFactory` + **DexScreener** ·
Jupiter price/mcap → **DexScreener** · Jupiter token audit → **GoPlus** ·
Meteora PnL API → computed on-chain (Phase 2).

**Scoring** mirrors Meridian: `feeTvlRatio*1000 + organic*10 + volume/100 + holders/100`.
Because Monad has no Jupiter "organic score", `organicProxy` is synthesized from
buy/sell balance, volume, and holder count (off by default).

## Setup

```bash
npm install
cp .env.example .env          # set RPC_URL (defaults to https://rpc.monad.xyz)
cp user-config.example.json user-config.json   # optional, to tune thresholds
```

## Usage

```bash
# Rank LP candidates (default 24h window)
npm run candidates -- --limit 10
npm run candidates -- --timeframe h6 --json

# Deep-dive one pool
npm run pool-detail -- --pool 0x<LBPair address>

# List every LFJ LBPair on Monad with basic metrics
npm run pairs
```

All commands are **read-only**. No transactions are ever sent in Phase 1.

## Lifecycle (Phase 2, DRY_RUN)

```bash
npm run balance                                  # wallet MON + token balances
npm run open -- --pool 0x... --amount-x 10 --amount-y 10 --strategy curve --bins-below 4 --bins-above 4
npm run positions
npm run pnl -- --position 1
npm run close -- --position 1
```

`DRY_RUN=true` (default) builds the exact `addLiquidity`/`removeLiquidity` tx,
validates its ABI encoding, logs the per-bin allocation, and records the position
to `state.json` — **without broadcasting**. Set `DRY_RUN=false` + `WALLET_PRIVATE_KEY`
to go live. PnL is computed on-chain from ERC1155 LBToken balances per bin.

## Roadmap

- **Phase 1 ✅** read-only screening.
- **Phase 2 ✅** position lifecycle in `DRY_RUN`: open/close via LBRouter
  (`addLiquidity`/`removeLiquidity`, spot/curve/bid_ask distributions), on-chain PnL
  from LBToken balances per bin.
- **Phase 3** automated manage loop (monitor / rebalance / exit rules) + ReAct LLM
  agent (screener + manager), decision log, learning/evolution.
- **Phase 4** Telegram control, cron scheduling, go-live with risk guardrails.

> ⚠️ **Before go-live (DRY_RUN=false):** `amountXMin/YMin` on add are set to a flat
> slippage and on remove to `0` — tighten these (derive from live reserves) and add
> per-position approval limits first.

## Notes & caveats

- Thresholds default LOOSE — Monad's LFJ TVL is small (~$3–4M mid-2026); Meridian's
  Solana defaults would filter out everything.
- `GOPLUS_CHAIN_ID` defaults to `143` (mainnet). If GoPlus hasn't indexed Monad,
  security enrichment degrades gracefully (gates skipped, not blocking).
- The `.reference/meridian` clone is a **read-only blueprint** (gitignored), not part
  of Wonder's code.
