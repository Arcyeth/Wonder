/** Ethers v6 provider for Monad mainnet (read-only). */
import { ethers } from "ethers";
import { CHAIN_ID, NETWORK_NAME } from "../constants";
import { config } from "../config";

let _provider: ethers.JsonRpcProvider | null = null;

export function getProvider(): ethers.JsonRpcProvider {
  if (_provider) return _provider;
  const network = ethers.Network.from({ chainId: CHAIN_ID, name: NETWORK_NAME });
  // staticNetwork avoids an eth_chainId probe per call (faster, fewer rate-limit hits).
  _provider = new ethers.JsonRpcProvider(config.chain.rpcUrl, network, {
    staticNetwork: network,
    batchMaxCount: 1, // some public Monad RPCs reject JSON-RPC batching
  });
  return _provider;
}

/** Sanity check: confirm the RPC is reachable and on chainId 143. */
export async function assertChain(): Promise<void> {
  const net = await getProvider().getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(
      `RPC ${config.chain.rpcUrl} is chainId ${net.chainId}, expected ${CHAIN_ID} (Monad mainnet). ` +
        `Set RPC_URL in .env.`,
    );
  }
}
