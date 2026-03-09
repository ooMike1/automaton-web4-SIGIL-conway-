/**
 * Task Handler — x402 payment gate + task execution
 */

// ─── Pricing ───────────────────────────────────────────────────
export const TASK_PRICING: Record<string, bigint> = {
  shell:     10_000n,  // $0.01 USDC (6 decimals atomic units)
  inference: 50_000n,  // $0.05 USDC
};

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

// ─── 402 Response Builder ──────────────────────────────────────
export function buildPaymentRequired(taskType: string, payToAddress: string) {
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
