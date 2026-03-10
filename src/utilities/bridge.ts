/**
 * Li.Fi Bridge Utility
 *
 * Bridges USDC between EVM chains using the Li.Fi REST API.
 * Max $50, min $0.10. Polls for completion up to 5 minutes.
 */

import { createPublicClient, createWalletClient, http } from "viem";
import type { Address, PrivateKeyAccount } from "viem";
import { base, mainnet, polygon, arbitrum } from "viem/chains";

const SUPPORTED_CHAINS: Record<string, { chain: any; rpc: string; usdcAddress: Address; chainId: number }> = {
  "eip155:1": {
    chain: mainnet,
    rpc: "https://eth.drpc.org",
    usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    chainId: 1,
  },
  "eip155:137": {
    chain: polygon,
    rpc: "https://polygon-rpc.com",
    usdcAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    chainId: 137,
  },
  "eip155:42161": {
    chain: arbitrum,
    rpc: "https://arb-mainnet.g.alchemy.com/v2/OzJPWxPbbiSE_ug5Vi0vq",
    usdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    chainId: 42161,
  },
  "eip155:8453": {
    chain: base,
    rpc: "https://mainnet.base.org",
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    chainId: 8453,
  },
};

const LIFI_API = "https://li.quest/v1";
const MAX_BRIDGE_ATOMIC = 50_000_000n;  // $50 USDC
const MIN_BRIDGE_ATOMIC = 100_000n;     // $0.10 USDC

export interface BridgeResult {
  txHash: string;
  toAmount: string;
  status: string;
}

/**
 * Bridge USDC from one EVM chain to another via Li.Fi.
 * Submits the bridge transaction and waits for completion (up to 5 min).
 */
export async function bridgeUsdc(
  account: PrivateKeyAccount,
  fromChain: string,
  toChain: string,
  amountUsdc: number,
): Promise<BridgeResult> {
  const amountAtomic = BigInt(Math.round(amountUsdc * 1_000_000));

  if (amountAtomic < MIN_BRIDGE_ATOMIC) {
    throw new Error(`Minimum bridge amount is $0.10 USDC`);
  }
  if (amountAtomic > MAX_BRIDGE_ATOMIC) {
    throw new Error(`Maximum bridge amount is $50 USDC`);
  }

  const from = SUPPORTED_CHAINS[fromChain];
  const to = SUPPORTED_CHAINS[toChain];
  if (!from) throw new Error(`Unsupported chain: ${fromChain}`);
  if (!to) throw new Error(`Unsupported chain: ${toChain}`);

  // Fetch Li.Fi quote
  const quoteUrl = `${LIFI_API}/quote?fromChain=${from.chainId}&toChain=${to.chainId}&fromToken=${from.usdcAddress}&toToken=${to.usdcAddress}&fromAmount=${amountAtomic}&fromAddress=${account.address}`;
  const quoteResp = await fetch(quoteUrl);
  if (!quoteResp.ok) {
    throw new Error(`Li.Fi quote failed: ${await quoteResp.text()}`);
  }
  const quote = await quoteResp.json();

  const txReq = quote.transactionRequest;
  if (!txReq) throw new Error("No transactionRequest in Li.Fi quote");

  // Submit transaction
  const walletClient = createWalletClient({
    account,
    chain: from.chain,
    transport: http(from.rpc),
  });
  const publicClient = createPublicClient({
    chain: from.chain,
    transport: http(from.rpc),
  });

  const txHash = await walletClient.sendTransaction({
    to: txReq.to as Address,
    data: txReq.data as `0x${string}`,
    value: txReq.value ? BigInt(txReq.value) : 0n,
    gas: txReq.gasLimit ? BigInt(txReq.gasLimit) : undefined,
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`[bridge] Submitted txHash: ${txHash}. Waiting for bridge completion...`);

  const toAmount = await pollBridgeStatus(txHash, from.chainId);
  return { txHash, toAmount, status: "completed" };
}

async function pollBridgeStatus(txHash: string, fromChainId: number): Promise<string> {
  const maxAttempts = 30; // 5 min at 10 s intervals
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    try {
      const resp = await fetch(`${LIFI_API}/status?txHash=${txHash}&fromChain=${fromChainId}`);
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data.status === "DONE") return data.receiving?.amount ?? "unknown";
      if (data.status === "FAILED") {
        throw new Error(`Bridge failed: ${data.substatusMessage ?? "unknown error"}`);
      }
    } catch (err: any) {
      if (err.message.startsWith("Bridge failed")) throw err;
      // Network error — continue polling
    }
  }
  throw new Error("Bridge timed out after 5 minutes");
}
