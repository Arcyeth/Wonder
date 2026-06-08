/**
 * Wallet layer — signer (optional) + balances. DRY_RUN-aware.
 *
 * Phase 2 defaults to DRY_RUN: a private key is NOT required to build/inspect
 * transactions. A key (and funds) is only needed to actually broadcast, which
 * happens only when DRY_RUN=false.
 */
import { ethers } from "ethers";
import { getProvider } from "./client";
import { ERC20_ABI } from "./abis";
import { config } from "../config";
import { NATIVE_SYMBOL } from "../constants";
import { log } from "../util/log";

let _wallet: ethers.Wallet | null = null;

/** The signer, if a private key is configured. Throws if asked to sign without one. */
export function getWallet(): ethers.Wallet | null {
  if (_wallet) return _wallet;
  const pk = config.wallet.privateKey;
  if (!pk) return null;
  _wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, getProvider());
  return _wallet;
}

export function requireWallet(): ethers.Wallet {
  const w = getWallet();
  if (!w) {
    throw new Error(
      "WALLET_PRIVATE_KEY is required for this action (broadcasting). " +
        "Set it in .env, or keep DRY_RUN=true to only build/validate transactions.",
    );
  }
  return w;
}

/** Resolved wallet address, or null in keyless dry-run. */
export function walletAddress(): string | null {
  return getWallet()?.address ?? null;
}

export interface TokenBalance {
  token: string;
  symbol: string;
  decimals: number;
  raw: bigint;
  human: number;
}

export async function getNativeBalance(address: string): Promise<number> {
  const raw = await getProvider().getBalance(address);
  return Number(ethers.formatEther(raw));
}

export async function getTokenBalance(
  token: string,
  address: string,
): Promise<TokenBalance> {
  const c = new ethers.Contract(token, ERC20_ABI, getProvider());
  const [raw, decimals, symbol] = await Promise.all([
    c.balanceOf(address) as Promise<bigint>,
    c.decimals().then(Number).catch(() => 18),
    c.symbol().catch(() => "?"),
  ]);
  return {
    token,
    symbol,
    decimals,
    raw,
    human: Number(ethers.formatUnits(raw, decimals)),
  };
}

/** Print-friendly summary of native + selected token balances. */
export async function getBalances(
  tokens: string[] = [],
): Promise<{ address: string | null; native: number; tokens: TokenBalance[] }> {
  const address = walletAddress();
  if (!address) {
    log.warn("wallet", "no WALLET_PRIVATE_KEY — balances unavailable (keyless dry-run).");
    return { address: null, native: 0, tokens: [] };
  }
  const native = await getNativeBalance(address);
  const balances = await Promise.all(
    [...new Set(tokens.map((t) => t.toLowerCase()))].map((t) => getTokenBalance(t, address)),
  );
  log.info("wallet", `${address} — ${native.toFixed(4)} ${NATIVE_SYMBOL} + ${balances.length} token(s)`);
  return { address, native, tokens: balances };
}

/** Ensure `spender` has at least `amount` allowance for `token`. DRY_RUN only logs. */
export async function ensureAllowance(
  token: string,
  spender: string,
  amount: bigint,
): Promise<{ ok: boolean; sent: boolean; note: string }> {
  const w = getWallet();
  if (!w) return { ok: false, sent: false, note: "no wallet (keyless dry-run)" };
  const c = new ethers.Contract(token, ERC20_ABI, w);
  const current: bigint = await c.allowance(w.address, spender);
  if (current >= amount) return { ok: true, sent: false, note: "allowance sufficient" };
  if (config.wallet.dryRun) {
    return { ok: true, sent: false, note: `DRY_RUN: would approve ${amount} to ${spender}` };
  }
  const tx = await c.approve(spender, amount);
  await tx.wait();
  return { ok: true, sent: true, note: `approved ${amount} (tx ${tx.hash})` };
}
