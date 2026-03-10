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
export const USDC_ADDRESSES: Record<string, Address> = {
  "eip155:1": getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),           // Ethereum mainnet
  "eip155:137": getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"),        // Polygon
  "eip155:42161": getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),      // Arbitrum ONE (native USDC)
  "eip155:8453": getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),       // Base mainnet
  "eip155:84532": getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),      // Base Sepolia
};

export const CHAINS: Record<string, any> = {
  "eip155:1": mainnet,
  "eip155:137": polygon,
  "eip155:42161": arbitrum,
  "eip155:8453": base,
  "eip155:84532": baseSepolia,
};

export const RPC_URLS: Record<string, string> = {
  "eip155:42161": "https://arb-mainnet.g.alchemy.com/v2/OzJPWxPbbiSE_ug5Vi0vq",
  "eip155:8453":  "https://mainnet.base.org",
  "eip155:1":     "https://eth.drpc.org",
  "eip155:137":   "https://polygon-rpc.com",
  "eip155:84532": "https://sepolia.base.org",
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
  resource?: string;
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

    const client = createPublicClient({
      chain,
      transport: http(RPC_URLS[network]),
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
 * Get USDC balance using Alchemy token API (more reliable than contract calls)
 */
async function getUsdcBalanceFromAlchemy(address: Address): Promise<number> {
  try {
    const resp = await fetch(
      `https://arb-mainnet.g.alchemy.com/v2/OzJPWxPbbiSE_ug5Vi0vq/getTokenBalances?address=${address}&contractAddresses=0xaf88d065e77c8cC2239327C5EDb3A432268e5831`
    );
    const data = await resp.json();

    if (data.result?.tokenBalances?.[0]?.tokenBalance) {
      const balance = BigInt(data.result.tokenBalances[0].tokenBalance);
      const usdc = Number(balance) / 1e6;
      if (usdc > 0) {
        console.log(`[x402] ✅ USDC Balance from Alchemy: ${usdc.toFixed(6)} USDC`);
        return usdc;
      }
    }
  } catch (err: any) {
    console.error(`[x402] Alchemy token API error: ${err.message}`);
  }
  return 0;
}

/**
 * Get the USDC balance for the automaton's wallet.
 * Attempts multiple networks to find balance.
 * Prioritizes Arbitrum as primary network.
 */
export async function getUsdcBalance(
  address: Address,
  network?: string,
): Promise<number> {
  // If a specific network is requested, query it directly
  if (network) {
    return checkNetworkBalance(address, network);
  }

  // Check all networks in parallel and return the total
  const networks = Object.keys(USDC_ADDRESSES);
  const balances = await Promise.all(
    networks.map((net) => checkNetworkBalance(address, net).catch(() => 0))
  );
  const total = balances.reduce((sum, b) => sum + b, 0);

  if (total === 0) {
    console.log(`[x402] ⚠️ No USDC balance found on any network for ${address}`);
  } else {
    const breakdown = networks
      .map((net, i) => balances[i] > 0 ? `${net}: ${balances[i].toFixed(4)}` : null)
      .filter(Boolean)
      .join(", ");
    console.log(`[x402] 💰 Total USDC: ${total.toFixed(4)} (${breakdown})`);
  }
  return total;
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
          payToAddress: accept.payToAddress || accept.payTo,
          requiredDeadlineSeconds:
            accept.requiredDeadlineSeconds || accept.maxTimeoutSeconds || 300,
          usdcAddress:
            accept.usdcAddress ||
            accept.asset ||
            USDC_ADDRESSES[accept.network] ||
            USDC_ADDRESSES["eip155:8453"],
        };
      }
    }

    // Try body (handles both x402 v1 and v2 field names)
    const body = await resp.json().catch(() => null);
    if (body?.accepts?.[0]) {
      const accept = body.accepts[0];
      return {
        scheme: accept.scheme,
        network: accept.network,
        maxAmountRequired: accept.maxAmountRequired,
        // v2 uses "payTo", v1 uses "payToAddress"
        payToAddress: accept.payToAddress || accept.payTo,
        // v2 uses "maxTimeoutSeconds", v1 uses "requiredDeadlineSeconds"
        requiredDeadlineSeconds:
          accept.requiredDeadlineSeconds || accept.maxTimeoutSeconds || 300,
        // v2 uses "asset", v1 uses "usdcAddress"
        usdcAddress:
          accept.usdcAddress ||
          accept.asset ||
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
  const normalizeAccept = (accept: any): PaymentRequirement => ({
    scheme: accept.scheme,
    network: accept.network,
    maxAmountRequired: accept.maxAmountRequired,
    payToAddress: accept.payToAddress || accept.payTo,
    requiredDeadlineSeconds:
      accept.requiredDeadlineSeconds || accept.maxTimeoutSeconds || 300,
    usdcAddress:
      accept.usdcAddress ||
      accept.asset ||
      USDC_ADDRESSES[accept.network] ||
      USDC_ADDRESSES["eip155:8453"],
    resource: accept.resource,
  });

  const header = resp.headers.get("X-Payment-Required");
  if (header) {
    try {
      const requirements = JSON.parse(
        Buffer.from(header, "base64").toString("utf-8"),
      );
      const accept = requirements.accepts?.[0];
      if (accept) return normalizeAccept(accept);
    } catch { }
  }

  try {
    const body = await resp.json();
    const accept = body.accepts?.[0];
    return accept ? normalizeAccept(accept) : null;
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

    // maxAmountRequired is already in atomic units (e.g. "5000000" = 5 USDC)
    const amount = BigInt(requirement.maxAmountRequired);

    // EIP-712 typed data for TransferWithAuthorization
    const domain = {
      name: "USD Coin",
      version: "2",
      chainId: CHAINS[requirement.network]?.id ?? 8453,
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
      x402Version: 2,
      scheme: requirement.scheme,
      network: requirement.network,
      ...(requirement.resource ? { resource: requirement.resource } : {}),
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
  } catch (err: any) {
    console.error(`[x402] signPayment error: ${err.message}`, {
      network: requirement.network,
      maxAmountRequired: requirement.maxAmountRequired,
      requiredDeadlineSeconds: requirement.requiredDeadlineSeconds,
      payToAddress: requirement.payToAddress,
      usdcAddress: requirement.usdcAddress,
    });
    return null;
  }
}
