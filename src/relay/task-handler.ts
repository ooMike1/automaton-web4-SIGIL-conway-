/**
 * Task Handler — x402 payment gate + task execution
 */
import { createPublicClient, createWalletClient, http } from "viem";
import type { Address, PrivateKeyAccount } from "viem";
import { base } from "viem/chains";

// ─── Pricing ───────────────────────────────────────────────────
export const TASK_PRICING: Record<string, bigint> = {
  shell:     10_000n,  // $0.01 USDC (6 decimals atomic units)
  inference: 50_000n,  // $0.05 USDC
};

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;

// ─── 402 Response Builder ──────────────────────────────────────
interface PaymentRequiredBody {
  accepts: Array<{
    scheme: string;
    network: string;
    maxAmountRequired: string;
    payToAddress: Address;
    asset: Address;         // x402 v2 field name
    maxTimeoutSeconds: number;
    resource: string;
  }>;
}

export function buildPaymentRequired(taskType: string, payToAddress: Address): PaymentRequiredBody {
  const amount = TASK_PRICING[taskType] ?? TASK_PRICING.shell;
  return {
    accepts: [{
      scheme: "exact",
      network: "eip155:8453",
      maxAmountRequired: amount.toString(),
      payToAddress,
      asset: USDC_BASE,
      maxTimeoutSeconds: 300,
      resource: "POST /v1/tasks",
    }],
  };
}

// ─── EIP-3009 Settlement ───────────────────────────────────────
const TRANSFER_WITH_AUTH_ABI = [{
  name: "transferWithAuthorization",
  type: "function",
  stateMutability: "nonpayable",
  inputs: [
    { name: "from",        type: "address" },
    { name: "to",          type: "address" },
    { name: "value",       type: "uint256" },
    { name: "validAfter",  type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce",       type: "bytes32" },
    { name: "v",           type: "uint8"   },
    { name: "r",           type: "bytes32" },
    { name: "s",           type: "bytes32" },
  ],
  outputs: [],
}] as const;

const BASE_RPC = "https://mainnet.base.org";

export interface SettleResult {
  ok: boolean;
  txHash?: string;
  error?: string;
}

export async function verifyAndSettlePayment(
  paymentHeader: string,
  taskType: string,
  account: PrivateKeyAccount,
): Promise<SettleResult> {
  let payment: any;
  try {
    payment = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
  } catch {
    return { ok: false, error: "Invalid X-Payment header (not base64 JSON)" };
  }

  const auth = payment?.payload?.authorization;
  const sig  = payment?.payload?.signature as string | undefined;
  if (!auth || !sig) return { ok: false, error: "Missing authorization or signature" };
  if (auth.to?.toLowerCase() !== account.address.toLowerCase()) {
    return { ok: false, error: "Payment authorization directed to wrong address" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (now < Number(auth.validAfter))  return { ok: false, error: "Payment not yet valid" };
  if (now > Number(auth.validBefore)) return { ok: false, error: "Payment expired" };

  const required = TASK_PRICING[taskType] ?? TASK_PRICING.shell;
  let payValue: bigint;
  try {
    payValue = BigInt(auth.value ?? "0");
  } catch {
    return { ok: false, error: "Invalid payment value" };
  }
  if (payValue < required) {
    return { ok: false, error: `Insufficient payment: got ${auth.value}, need ${required}` };
  }

  // Decompose compact 65-byte signature into v, r, s
  const hex = (sig.startsWith("0x") ? sig.slice(2) : sig);
  if (hex.length !== 130) return { ok: false, error: "Invalid signature length" };
  const r = `0x${hex.slice(0, 64)}`   as `0x${string}`;
  const s = `0x${hex.slice(64, 128)}` as `0x${string}`;
  const v = parseInt(hex.slice(128, 130), 16);

  try {
    const walletClient = createWalletClient({ account, chain: base, transport: http(BASE_RPC) });
    const publicClient = createPublicClient({ chain: base, transport: http(BASE_RPC) });

    const hash = await walletClient.writeContract({
      address: USDC_BASE,
      abi: TRANSFER_WITH_AUTH_ABI,
      functionName: "transferWithAuthorization",
      args: [
        auth.from  as Address,
        auth.to    as Address,
        BigInt(auth.value),
        BigInt(auth.validAfter),
        BigInt(auth.validBefore),
        auth.nonce as `0x${string}`,
        v, r, s,
      ],
      chain: base,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return { ok: true, txHash: hash };
  } catch (err: any) {
    return { ok: false, error: `Settlement failed: ${err.shortMessage || err.message}` };
  }
}
