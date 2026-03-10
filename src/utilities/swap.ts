/**
 * Li.Fi Same-Chain Token Swap Utility
 *
 * Swaps tokens on the same EVM chain via Li.Fi.
 * Handles native ETH and ERC-20 inputs, including allowance management.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  parseUnits,
} from "viem";
import type { Address, Chain, PrivateKeyAccount } from "viem";
import { base, mainnet, polygon, arbitrum } from "viem/chains";

// Li.Fi uses the zero address for native gas tokens (ETH, MATIC, etc.)
const NATIVE_TOKEN_ADDR = "0x0000000000000000000000000000000000000000";

const LIFI_API = "https://li.quest/v1";

const SUPPORTED_CHAINS: Record<string, { chain: Chain; rpc: string; chainId: number }> = {
  "eip155:1":     { chain: mainnet,  rpc: "https://eth.drpc.org",                                        chainId: 1 },
  "eip155:137":   { chain: polygon,  rpc: "https://polygon-rpc.com",                                     chainId: 137 },
  "eip155:42161": { chain: arbitrum, rpc: "https://arb-mainnet.g.alchemy.com/v2/OzJPWxPbbiSE_ug5Vi0vq", chainId: 42161 },
  "eip155:8453":  { chain: base,     rpc: "https://base.drpc.org",                                       chainId: 8453 },
};

const TOKEN_ABI = [
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner",   type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount",  type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface SwapResult {
  txHash: string;
  toAmount: string; // atomic units as string, from Li.Fi estimate
}

/**
 * Swap tokens on the same EVM chain via Li.Fi.
 * @param account  Wallet account (signer)
 * @param chain    CAIP-2 chain ID, e.g. "eip155:8453"
 * @param fromToken "native" for ETH/gas token, or checksummed ERC-20 address
 * @param toToken   "native" for ETH/gas token, or checksummed ERC-20 address
 * @param amountIn  Human-readable input amount (e.g. 0.005 for 0.005 ETH)
 */
export async function swapTokens(
  account: PrivateKeyAccount,
  chain: string,
  fromToken: string,
  toToken: string,
  amountIn: number,
): Promise<SwapResult> {
  const c = SUPPORTED_CHAINS[chain];
  if (!c) throw new Error(`Unsupported chain: ${chain}`);

  const isNativeFrom = fromToken.toLowerCase() === "native";
  const fromAddr = isNativeFrom
    ? NATIVE_TOKEN_ADDR
    : getAddress(fromToken);
  const toAddr = toToken.toLowerCase() === "native"
    ? NATIVE_TOKEN_ADDR
    : getAddress(toToken);

  const publicClient = createPublicClient({ chain: c.chain, transport: http(c.rpc) });
  const walletClient = createWalletClient({ account, chain: c.chain, transport: http(c.rpc) });

  // Determine token decimals to compute atomic amount
  let decimals = 18; // native ETH default
  if (!isNativeFrom) {
    decimals = await publicClient.readContract({
      address: fromAddr as Address,
      abi: TOKEN_ABI,
      functionName: "decimals",
    });
  }
  const amountAtomic = parseUnits(amountIn.toFixed(decimals), decimals);

  // Fetch Li.Fi quote (fromChain === toChain = same-chain swap)
  const quoteUrl =
    `${LIFI_API}/quote` +
    `?fromChain=${c.chainId}&toChain=${c.chainId}` +
    `&fromToken=${fromAddr}&toToken=${toAddr}` +
    `&fromAmount=${amountAtomic}` +
    `&fromAddress=${account.address}` +
    `&slippage=0.005`;

  const quoteResp = await fetch(quoteUrl);
  if (!quoteResp.ok) {
    throw new Error(`Li.Fi quote failed: ${await quoteResp.text()}`);
  }
  const quote = await quoteResp.json();

  const txReq = quote.transactionRequest;
  if (!txReq) throw new Error("No transactionRequest in Li.Fi swap quote");

  // For ERC-20 input: check allowance and approve if needed
  if (!isNativeFrom) {
    const spender = txReq.to as Address;
    const allowance = await publicClient.readContract({
      address: fromAddr as Address,
      abi: TOKEN_ABI,
      functionName: "allowance",
      args: [account.address, spender],
    });
    if (allowance < amountAtomic) {
      console.log(`[swap] Approving ${amountAtomic} of ${fromAddr} for spender ${spender}...`);
      const approveHash = await walletClient.writeContract({
        address: fromAddr as Address,
        abi: TOKEN_ABI,
        functionName: "approve",
        args: [spender, amountAtomic],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }
  }

  // Submit swap transaction
  const txHash = await walletClient.sendTransaction({
    to:    txReq.to    as Address,
    data:  txReq.data  as `0x${string}`,
    value: txReq.value ? BigInt(txReq.value) : 0n,
    gas:   txReq.gasLimit ? BigInt(txReq.gasLimit) : undefined,
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });

  const toAmount: string =
    quote.estimate?.toAmount ?? quote.action?.toAmount ?? "unknown";
  console.log(`[swap] ✅ Swap complete. txHash: ${txHash}. toAmount: ${toAmount}`);
  return { txHash, toAmount };
}
