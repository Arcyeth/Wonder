/**
 * Position lifecycle — open (addLiquidity) and close (removeLiquidity) on the
 * LFJ LBRouter v2.2. DRY_RUN-aware: in dry-run we build the exact transaction,
 * validate its ABI encoding, log the per-bin plan, and record the (simulated)
 * position to state — but never broadcast.
 */
import { ethers } from "ethers";
import { readPair, readPositionLiquidity } from "./lb";
import { buildDistribution, perBinAmounts, PRECISION } from "./lb-strategy";
import {
  getWallet,
  requireWallet,
  walletAddress,
  ensureAllowance,
} from "./wallet";
import { getProvider } from "./client";
import { LB_ROUTER_ABI } from "./abis";
import { LB_ROUTER } from "../constants";
import { config } from "../config";
import { getPair } from "../data/dexscreener";
import { tokenUsdPrices } from "../data/pnl";
import { addPosition, markClosed, type Position } from "../state";
import { log } from "../util/log";
import type { Strategy } from "../types";

function slippageMin(amount: bigint, pct: number): bigint {
  const bps = BigInt(Math.round(pct * 100));
  return (amount * (10_000n - bps)) / 10_000n;
}

export interface OpenParams {
  pool: string;
  amountX: number; // human units of tokenX
  amountY: number; // human units of tokenY
  strategy?: Strategy;
  binsBelow?: number;
  binsAbove?: number;
}

export interface OpenResult {
  dryRun: boolean;
  position: Position;
  liquidityParameters: Record<string, unknown>;
  encodedOk: boolean;
  perBin: { id: number; deltaId: number; amountX: string; amountY: string }[];
  txHash: string | null;
  note: string;
}

export async function openPosition(params: OpenParams): Promise<OpenResult> {
  const m = config.management;
  const strategy = params.strategy ?? m.strategy;
  const binsBelow = params.binsBelow ?? m.binsBelow;
  const binsAbove = params.binsAbove ?? m.binsAbove;

  const oc = await readPair(params.pool);
  const amountXRaw = ethers.parseUnits(String(params.amountX || 0), oc.decimalsX);
  const amountYRaw = ethers.parseUnits(String(params.amountY || 0), oc.decimalsY);
  if (amountXRaw === 0n && amountYRaw === 0n) {
    throw new Error("Both amounts are 0 — nothing to deploy.");
  }

  const dist = buildDistribution({
    activeId: oc.activeId,
    binsBelow,
    binsAbove,
    strategy,
    hasX: amountXRaw > 0n,
    hasY: amountYRaw > 0n,
  });

  const to = walletAddress() ?? ethers.ZeroAddress;
  const deadline = Math.floor(Date.now() / 1000) + m.deadlineSec;

  const liquidityParameters = {
    tokenX: oc.tokenX,
    tokenY: oc.tokenY,
    binStep: oc.binStep,
    amountX: amountXRaw,
    amountY: amountYRaw,
    amountXMin: slippageMin(amountXRaw, m.amountSlippagePct),
    amountYMin: slippageMin(amountYRaw, m.amountSlippagePct),
    activeIdDesired: oc.activeId,
    idSlippage: m.idSlippage,
    deltaIds: dist.deltaIds,
    distributionX: dist.distributionX,
    distributionY: dist.distributionY,
    to,
    refundTo: to,
    deadline,
  };

  // Validate the tx is well-formed (correct ABI types) without broadcasting.
  const router = new ethers.Contract(LB_ROUTER, LB_ROUTER_ABI, getProvider());
  let encodedOk = false;
  try {
    router.interface.encodeFunctionData("addLiquidity", [liquidityParameters]);
    encodedOk = true;
  } catch (e) {
    throw new Error(`addLiquidity param encoding failed: ${(e as Error).message}`);
  }

  // Approvals (dry-run only logs intent).
  if (amountXRaw > 0n) {
    const a = await ensureAllowance(oc.tokenX, LB_ROUTER, amountXRaw);
    log.debug("lb-write", `approve ${oc.symbolX}: ${a.note}`);
  }
  if (amountYRaw > 0n) {
    const a = await ensureAllowance(oc.tokenY, LB_ROUTER, amountYRaw);
    log.debug("lb-write", `approve ${oc.symbolY}: ${a.note}`);
  }

  // USD valuation of the deposit.
  const dex = await getPair(params.pool).catch(() => null);
  const { priceXusd, priceYusd } = tokenUsdPrices(dex, oc.tokenX);
  const amountXHuman = Number(ethers.formatUnits(amountXRaw, oc.decimalsX));
  const amountYHuman = Number(ethers.formatUnits(amountYRaw, oc.decimalsY));
  const depositValueUsd =
    priceXusd != null && priceYusd != null
      ? amountXHuman * priceXusd + amountYHuman * priceYusd
      : null;

  const perBin = perBinAmounts(amountXRaw, amountYRaw, dist).map((b) => ({
    id: b.id,
    deltaId: b.deltaId,
    amountX: b.amountX.toString(),
    amountY: b.amountY.toString(),
  }));

  const deployedAt = Date.now();
  const position: Position = {
    id: `${params.pool}-${deployedAt}`,
    pool: params.pool,
    name: `${oc.symbolX}-${oc.symbolY}`,
    tokenX: oc.tokenX,
    tokenY: oc.tokenY,
    symbolX: oc.symbolX,
    symbolY: oc.symbolY,
    decimalsX: oc.decimalsX,
    decimalsY: oc.decimalsY,
    binStep: oc.binStep,
    strategy,
    activeIdAtDeploy: oc.activeId,
    deltaIds: dist.deltaIds,
    binIds: dist.ids,
    amountXRaw: amountXRaw.toString(),
    amountYRaw: amountYRaw.toString(),
    amountXHuman,
    amountYHuman,
    depositValueUsd,
    priceXusdAtDeploy: priceXusd,
    priceYusdAtDeploy: priceYusd,
    dryRun: config.wallet.dryRun,
    txHash: null,
    deployedAt,
    closed: false,
    closedAt: null,
    closeTxHash: null,
    notes: "",
  };

  if (config.wallet.dryRun) {
    addPosition(position);
    return {
      dryRun: true,
      position,
      liquidityParameters: stringifyBig(liquidityParameters),
      encodedOk,
      perBin,
      txHash: null,
      note: "DRY_RUN: transaction built & validated, position recorded. Not broadcast.",
    };
  }

  // ── live path ──
  const wallet = requireWallet();
  const liveRouter = new ethers.Contract(LB_ROUTER, LB_ROUTER_ABI, wallet);
  // Simulate first to surface reverts cheaply.
  await liveRouter.addLiquidity.staticCall(liquidityParameters);
  const tx = await liveRouter.addLiquidity(liquidityParameters);
  log.info("lb-write", `addLiquidity sent: ${tx.hash}`);
  await tx.wait();
  position.txHash = tx.hash;
  addPosition(position);
  return {
    dryRun: false,
    position,
    liquidityParameters: stringifyBig(liquidityParameters),
    encodedOk,
    perBin,
    txHash: tx.hash,
    note: `Broadcast: ${tx.hash}`,
  };
}

export interface CloseResult {
  dryRun: boolean;
  positionId: string;
  ids: number[];
  amounts: string[];
  hasOnchainLiquidity: boolean;
  encodedOk: boolean;
  txHash: string | null;
  note: string;
}

export async function closePosition(position: Position): Promise<CloseResult> {
  const owner = walletAddress();
  const m = config.management;
  const deadline = Math.floor(Date.now() / 1000) + m.deadlineSec;

  // Read the owner's actual LBToken balances per bin (what we'd burn).
  let ids: number[] = [];
  let amounts: bigint[] = [];
  let hasOnchainLiquidity = false;
  if (owner) {
    const bins = await readPositionLiquidity(position.pool, owner, position.binIds);
    for (const b of bins) {
      if (b.balance > 0n) {
        ids.push(b.id);
        amounts.push(b.balance);
      }
    }
    hasOnchainLiquidity = ids.length > 0;
  }

  // State-only close (simulated/never-minted dry position, or no wallet).
  if (!hasOnchainLiquidity) {
    markClosed(position.id, null);
    return {
      dryRun: config.wallet.dryRun,
      positionId: position.id,
      ids: [],
      amounts: [],
      hasOnchainLiquidity: false,
      encodedOk: true,
      txHash: null,
      note: "No on-chain LBToken balance (simulated/dry position). Marked closed in state only.",
    };
  }

  const args = [
    position.tokenX,
    position.tokenY,
    position.binStep,
    0n, // amountXMin (TODO: derive slippage from live reserves before go-live)
    0n, // amountYMin
    ids,
    amounts,
    owner,
    deadline,
  ];

  const router = new ethers.Contract(LB_ROUTER, LB_ROUTER_ABI, getProvider());
  let encodedOk = false;
  try {
    router.interface.encodeFunctionData("removeLiquidity", args);
    encodedOk = true;
  } catch (e) {
    throw new Error(`removeLiquidity encoding failed: ${(e as Error).message}`);
  }

  if (config.wallet.dryRun) {
    markClosed(position.id, null);
    return {
      dryRun: true,
      positionId: position.id,
      ids,
      amounts: amounts.map((a) => a.toString()),
      hasOnchainLiquidity: true,
      encodedOk,
      txHash: null,
      note: "DRY_RUN: removeLiquidity built & validated over live balances. Not broadcast.",
    };
  }

  const wallet = requireWallet();
  const liveRouter = new ethers.Contract(LB_ROUTER, LB_ROUTER_ABI, wallet);
  await liveRouter.removeLiquidity.staticCall(...args);
  const tx = await liveRouter.removeLiquidity(...args);
  log.info("lb-write", `removeLiquidity sent: ${tx.hash}`);
  await tx.wait();
  markClosed(position.id, tx.hash);
  return {
    dryRun: false,
    positionId: position.id,
    ids,
    amounts: amounts.map((a) => a.toString()),
    hasOnchainLiquidity: true,
    encodedOk,
    txHash: tx.hash,
    note: `Broadcast: ${tx.hash}`,
  };
}

function stringifyBig(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "bigint") out[k] = v.toString();
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === "bigint" ? x.toString() : x));
    else out[k] = v;
  }
  return out;
}
