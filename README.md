# Wonder

**Autonomous DLMM / LP agent for [LFJ Liquidity Book](https://lfj.gg) on [Monad](https://monad.xyz).**

Wonder screens LFJ Liquidity Book (DLMM) pools on Monad, opens / manages / closes
concentrated-liquidity positions, computes PnL on-chain, and is driven from a CLI
with configurable risk settings — with an autonomous agent loop and Telegram
control coming in later phases.

> **Status:** Phase 1 (screening) + Phase 2 (DRY_RUN lifecycle) complete.
> Everything defaults to read-only / dry-run — no transactions are sent unless
> you explicitly opt in.

---

## Why Monad + LFJ

- **LFJ Liquidity Book** is a true DLMM: liquidity is segmented into discrete
  **bins** at fixed price points, giving zero-slippage swaps within a bin,
  concentrated capital, and dynamic (volatility-based) fees for LPs.
- **Monad** is an EVM L1 (chainId `143`) with ~400 ms blocks / ~800 ms finality —
  ideal for high-frequency LP management.

LFJ v2.2 (the live DLMM) on Monad mainnet:

| Contract  | Address |
|-----------|---------|
| LBFactory | `0xb43120c4745967fa9b93E79C149E66B0f2D6Fe0c` |
| LBRouter  | `0x18556DA13313f3532c54711497A8FedAC273220E` |

## Architecture

```
src/
  constants.ts        Monad/LFJ addresses, chainId, API endpoints
  config.ts           .env + user-config.json → config (risk thresholds)
  types.ts            shared types
  chain/
    client.ts         ethers v6 provider (Monad mainnet, staticNetwork)
    abis.ts           LBFactory / LBPair / LBRouter / ERC20 ABIs
    lb.ts             LB reader: enumerate pairs, binStep/activeId/reserves/fee,
                      price, per-bin LBToken balances
    lb-strategy.ts    bin distribution math (spot / curve / bid_ask)
    lb-write.ts       open (addLiquidity) / close (removeLiquidity), DRY_RUN-aware
    wallet.ts         signer + MON/ERC20 balances + approvals
  data/
    dexscreener.ts    TVL / volume / mcap / price for Monad pairs
    goplus.ts         token security: honeypot / holders / tax / top-10
    pnl.ts            on-chain position valuation & PnL
  screening.ts        discover → pre-filter → enrich → hard-filter → score → rank
  state.ts            JSON position registry
  cli.ts              candidates / pool-detail / pairs / balance / open /
                      positions / pnl / close
```

**Data sources:** pool/token metrics (TVL, volume, mcap, price) from **DexScreener**
(`chain "monad"`, `dexId "traderjoe"`); token security (honeypot, holders, tax,
top-10 concentration) from **GoPlus**; bin steps, fees, reserves, active bin, and
position LBToken balances read **directly on-chain** from the verified LFJ v2.2
contracts; PnL computed on-chain.

**Candidate scoring:** `feeTvlRatio*1000 + organicProxy*10 + volume/100 + holders/100`.
`organicProxy` (0–100) is synthesized from buy/sell balance, volume, and holder
count as a proxy for organic activity (off by default).

## Setup

```bash
npm install
cp .env.example .env          # set RPC_URL (defaults to https://rpc.monad.xyz)
cp user-config.example.json user-config.json   # optional, to tune thresholds
```

## Screening (read-only)

```bash
npm run candidates -- --limit 10                 # rank LP candidates (24h window)
npm run candidates -- --timeframe h6 --json
npm run pool-detail -- --pool 0x<LBPair address> # deep-dive one pool
npm run pairs                                    # list all LFJ LBPairs on Monad
```

## Lifecycle (DRY_RUN by default)

```bash
npm run balance                                  # wallet MON + token balances
npm run open -- --pool 0x... --amount-x 10 --amount-y 10 --strategy curve --bins-below 4 --bins-above 4
npm run positions
npm run pnl -- --position 1
npm run close -- --position 1
```

`DRY_RUN=true` (default) builds the exact `addLiquidity` / `removeLiquidity` tx,
validates its ABI encoding, logs the per-bin allocation, and records the position
to `state.json` — **without broadcasting**. Set `DRY_RUN=false` + `WALLET_PRIVATE_KEY`
to go live. PnL is computed on-chain from ERC1155 LBToken balances per bin.

## Agent cycles (deterministic, DRY_RUN by default)

```bash
npm run screen                                   # rank candidates, select top pick
npm run screen -- --deploy --amount-y 5          # auto-open the top pick (dry-run)
npm run manage                                   # evaluate open positions, close per rules
npm run manage -- --no-execute                   # evaluate only, don't close
npm run decisions                                # recent agent decision log
```

The **screen cycle** ranks pools, drops ones already held, and (optionally) opens the
top pick. The **manage cycle** reads each position's on-chain PnL and applies hard exit
rules — **stop-loss** (`pnl% ≤ stopLossPct`), **take-profit** (`pnl% ≥ takeProfitPct`),
and optional **out-of-range** close — then acts (DRY_RUN-aware). Every decision is
written to `decision-log.json`. These mechanics are what the LLM layer will orchestrate.

## LLM agent (Phase 3b)

A ReAct agent drives the same tools, OpenAI-compatible and provider-agnostic
(OpenRouter, a local LM Studio endpoint, OpenAI, …). Configure `LLM_BASE_URL`,
`LLM_API_KEY` (or `OPENROUTER_API_KEY`), and `LLM_MODEL` in `.env`.

```bash
npm run wonder -- agent "find the best pool and open a small position" --role screener
npm run wonder -- agent "review my positions and close anything that breached its rules" --role manager
npm run wonder -- agent "what's my best LP option right now and why?"
```

The agent calls tools (`get_candidates`, `get_position_pnl`, `run_screen_cycle`,
`open_position`, `close_position`, …) and is bounded by the same DRY_RUN guard —
it can't broadcast unless `DRY_RUN=false`. Without an LLM key, the deterministic
`screen` / `manage` cycles still work.

## Roadmap

- **Phase 1 ✅** read-only screening.
- **Phase 2 ✅** position lifecycle in `DRY_RUN`: open/close via LBRouter
  (`addLiquidity` / `removeLiquidity`, spot/curve/bid_ask distributions), on-chain
  PnL from LBToken balances per bin.
- **Phase 3a ✅** deterministic agent cycles: screen → deploy, manage → exit rules,
  decision log.
- **Phase 3b ✅** LLM ReAct agent (screener / manager / general) over the same tools,
  provider-agnostic (OpenRouter / local / OpenAI).
- **Phase 4** Telegram control, cron scheduling, learning/evolution, go-live guardrails.

> ⚠️ **Before go-live (`DRY_RUN=false`):** `amountXMin/YMin` on add are set to a flat
> slippage and on remove to `0` — tighten these (derive from live reserves) and add
> per-position approval limits first.

## Notes

- Thresholds default LOOSE — Monad's LFJ TVL is still small (~$3–4M mid-2026), so
  aggressive filters would screen out every pool. Tune in `user-config.json`.
- `GOPLUS_CHAIN_ID` defaults to `143` (mainnet). If GoPlus hasn't indexed a token,
  security enrichment degrades gracefully (gates skipped, not blocking).
