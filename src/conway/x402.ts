/**
 * x402 Payment Protocol
 *
 * Enables the automaton to make USDC micropayments via HTTP 402.
 * Adapted from conway-mcp/src/x402/index.ts
 */

import {
  createPublicClient,
  http,
  parseUnits,
  type Address,
  type PrivateKeyAccount,
  getAddress,
} from "viem";
import { base, baseSepolia, mainnet, polygon, arbitrum } from "viem/chains";

// USDC contract addresses on multiple networks (with correct checksums)
const USDC_ADDRESSES: Record<string, Address> = {
  "eip155:1": getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),           // Ethereum mainnet
  "eip155:137": getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"),        // Polygon
  "eip155:42161": getAddress("0xFF970A61A04b1cA14834A43f5dE4533eBDDB5F8f"),      // Arbitrum ONE
  "eip155:8453": getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),       // Base mainnet
  "eip155:84532": getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),      // Base Sepolia
};

const CHAINS: Record<string, any> = {
  "eip155:1": mainnet,
  "eip155:137": polygon,
  "eip155:42161": arbitrum,
  "eip155:8453": base,
  "eip155:84532": baseSepolia,
};

const BALANCE_OF_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

interface PaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  payToAddress: Address;
  requiredDeadlineSeconds: number;
  usdcAddress: Address;
}

interface X402PaymentResult {
  success: boolean;
  response?: any;
  error?: string;
}

/**
 * Check USDC balance on a specific network.
 */
async function checkNetworkBalance(
  address: Address,
  network: string,
): Promise<number> {
  const chain = CHAINS[network];
  const usdcAddress = USDC_ADDRESSES[network];

  if (!chain || !usdcAddress) return 0;

  try {
    // Ensure address has correct checksum
    const checksummedAddress = getAddress(address);

    console.log(`[x402] Checking ${network}: ${chain.name} (USDC: ${usdcAddress})`);

    const rpcUrls: Record<string, string> = {
      "eip155:42161": "https://arb-mainnet.g.alchemy.com/v2/OzJPWxPbbiSE_ug5Vi0vq", // Arbitrum (Alchemy)
      "eip155:8453": "https://mainnet.base.org", // Base
      "eip155:1": "https://eth.drpc.org", // Ethereum
      "eip155:137": "https://polygon-rpc.com", // Polygon
      "eip155:84532": "https://sepolia.base.org", // Base Sepolia
    };

    const client = createPublicClient({
      chain,
      transport: http(rpcUrls[network]),
    });

    const balance = await client.readContract({
      address: usdcAddress,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [checksummedAddress],
    });

    const usdcAmount = Number(balance) / 1_000_000;
    if (usdcAmount > 0) {
      console.log(`[x402] ✅ Found ${usdcAmount} USDC on ${network}`);
    }
    return usdcAmount;
  } catch (err: any) {
    console.error(`[x402] Error on ${network}: ${err.shortMessage || err.message}`);
    return 0;
  }
}

/**
 * Get the USDC balance for the automaton's wallet.
 * Attempts multiple networks to find balance.
 * Prioritizes Arbitrum as primary network.
 */
export async function getUsdcBalance(
  address: Address,
  network: string = "eip155:42161", // Arbitrum as primary
): Promise<number> {
  // Try primary network first
  const primaryBalance = await checkNetworkBalance(address, network);
  if (primaryBalance > 0) return primaryBalance;

  // If primary failed, try all other networks
  console.log(`[x402] Balance 0 on ${network}. Scanning all networks...`);
  const networksToTry = ["eip155:42161", "eip155:8453", "eip155:84532", "eip155:1", "eip155:137"];

  for (const net of networksToTry) {
    if (net === network) continue; // Skip the one we already tried

    try {
      const balance = await checkNetworkBalance(address, net);
      if (balance > 0) return balance;
    } catch (err: any) {
      console.error(`[x402] Error checking ${net}: ${err.message}`);
    }
  }

  console.log(`[x402] ⚠️ No USDC balance found on any network for ${address}`);
  console.log(`[x402] Note: Check https://arbiscan.io/address/${address} manually`);
  return 0;
}

/**
 * Check if a URL requires x402 payment.
 */
export async function checkX402(
  url: string,
): Promise<PaymentRequirement | null> {
  try {
    const resp = await fetch(url, { method: "GET" });
    if (resp.status !== 402) {
      return null;
    }

    // Try X-Payment-Required header
    const header = resp.headers.get("X-Payment-Required");
    if (header) {
      const requirements = JSON.parse(
        Buffer.from(header, "base64").toString("utf-8"),
      );
      const accept = requirements.accepts?.[0];
      if (accept) {
        return {
          scheme: accept.scheme,
          network: accept.network,
          maxAmountRequired: accept.maxAmountRequired,
          payToAddress: accept.payToAddress,
          requiredDeadlineSeconds: accept.requiredDeadlineSeconds || 300,
          usdcAddress:
            accept.usdcAddress ||
            USDC_ADDRESSES[accept.network] ||
            USDC_ADDRESSES["eip155:8453"],
        };
      }
    }

    // Try body
    const body = await resp.json().catch(() => null);
    if (body?.accepts?.[0]) {
      const accept = body.accepts[0];
      return {
        scheme: accept.scheme,
        network: accept.network,
        maxAmountRequired: accept.maxAmountRequired,
        payToAddress: accept.payToAddress,
        requiredDeadlineSeconds: accept.requiredDeadlineSeconds || 300,
        usdcAddress:
          accept.usdcAddress ||
          USDC_ADDRESSES[accept.network] ||
          USDC_ADDRESSES["eip155:8453"],
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch a URL with automatic x402 payment.
 * If the endpoint returns 402, sign and pay, then retry.
 */
export async function x402Fetch(
  url: string,
  account: PrivateKeyAccount,
  method: string = "GET",
  body?: string,
  headers?: Record<string, string>,
): Promise<X402PaymentResult> {
  try {
    // Initial request
    const initialResp = await fetch(url, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      body,
    });

    if (initialResp.status !== 402) {
      const data = await initialResp
        .json()
        .catch(() => initialResp.text());
      return { success: initialResp.ok, response: data };
    }

    // Parse payment requirements
    const requirement = await parsePaymentRequired(initialResp);
    if (!requirement) {
      return { success: false, error: "Could not parse payment requirements" };
    }

    // Sign payment
    const payment = await signPayment(account, requirement);
    if (!payment) {
      return { success: false, error: "Failed to sign payment" };
    }

    // Retry with payment
    const paymentHeader = Buffer.from(
      JSON.stringify(payment),
    ).toString("base64");

    const paidResp = await fetch(url, {
      method,
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "X-Payment": paymentHeader,
      },
      body,
    });

    const data = await paidResp.json().catch(() => paidResp.text());
    return { success: paidResp.ok, response: data };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function parsePaymentRequired(
  resp: Response,
): Promise<PaymentRequirement | null> {
  const header = resp.headers.get("X-Payment-Required");
  if (header) {
    try {
      const requirements = JSON.parse(
        Buffer.from(header, "base64").toString("utf-8"),
      );
      const accept = requirements.accepts?.[0];
      if (accept) return accept;
    } catch { }
  }

  try {
    const body = await resp.json();
    return body.accepts?.[0] || null;
  } catch {
    return null;
  }
}

async function signPayment(
  account: PrivateKeyAccount,
  requirement: PaymentRequirement,
): Promise<any | null> {
  try {
    const nonce = `0x${Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("hex")}`;

    const now = Math.floor(Date.now() / 1000);
    const validAfter = now - 60;
    const validBefore = now + requirement.requiredDeadlineSeconds;

    const amount = parseUnits(requirement.maxAmountRequired, 6);

    // EIP-712 typed data for TransferWithAuthorization
    const domain = {
      name: "USD Coin",
      version: "2",
      chainId: requirement.network === "eip155:84532" ? 84532 : 8453,
      verifyingContract: requirement.usdcAddress,
    } as const;

    const types = {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    } as const;

    const message = {
      from: account.address,
      to: requirement.payToAddress,
      value: amount,
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce: nonce as `0x${string}`,
    };

    const signature = await account.signTypedData({
      domain,
      types,
      primaryType: "TransferWithAuthorization",
      message,
    });

    return {
      x402Version: 1,
      scheme: "exact",
      network: requirement.network,
      payload: {
        signature,
        authorization: {
          from: account.address,
          to: requirement.payToAddress,
          value: amount.toString(),
          validAfter: validAfter.toString(),
          validBefore: validBefore.toString(),
          nonce,
        },
      },
    };
  } catch {
    return null;
  }
}
