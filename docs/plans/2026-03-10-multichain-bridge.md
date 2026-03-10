# Multi-Chain Bridge & Payment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable Agatha to bridge USDC via Li.Fi, accept task payments on any funded EVM chain, sign x402 payments on the correct chain, and announce multi-chain capability to the network.

**Architecture:** Five independent tasks: (1) Li.Fi bridge utility, (2) `bridge_usdc` agent tool wired into the existing tools registry, (3) x402.ts gets exported constants and a chainId fix in `signPayment`, (4) task-handler + server get multi-chain settlement and multi-accept 402 responses, (5) agent-card.json and system prompt announce multi-chain support.

**Tech Stack:** TypeScript, viem, better-sqlite3, Li.Fi REST API v1, vitest.

---

## Codebase Context

- **`src/utilities/bridge.ts`** — New file. Wrap Li.Fi REST API.
- **`src/agent/tools.ts`** — 1650 lines. `createBuiltinTools(sandboxId)` returns all tools as an array. Last tool ends at line ~1589 (just before the closing `]`). Add `bridge_usdc` there. Uses `category: "financial"` for wallet tools.
- **`src/conway/x402.ts`** — CHAINS and USDC_ADDRESSES are private consts. `rpcUrls` is defined inside `checkNetworkBalance`. `signPayment` hardcodes `chainId: requirement.network === "eip155:84532" ? 84532 : 8453` at line 349.
- **`src/relay/task-handler.ts`** — `USDC_BASE` and `BASE_RPC` hardcoded at top. `buildPaymentRequired` is sync and returns a single Base `accepts` entry. `verifyAndSettlePayment` uses `base` chain and `USDC_BASE` unconditionally.
- **`src/relay/server.ts`** — Calls `buildPaymentRequired(type, account.address, db)` at line 229 (not awaited since it's currently sync).
- **`src/index.ts`** — Builds agent-card.json in two places: `try` block (update existing) at ~line 211–232 and `catch` block (create new) at ~line 235–253. Both need `capabilities` and `networks` fields.
- **`src/agent/system-prompt.ts`** — `OPERATIONAL_CONTEXT` const at line ~85. Contains `- Make USDC payments via x402 protocol` which needs updating.
- **Tests:** `src/__tests__/` uses vitest. Run with `pnpm test`.

---

### Task 1: Li.Fi Bridge Utility

**Files:**
- Create: `src/utilities/bridge.ts`
- Create: `src/__tests__/bridge.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/__tests__/bridge.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { bridgeUsdc } from "../utilities/bridge.js";

describe("bridgeUsdc validation", () => {
  it("throws if amountUsdc below minimum (< 0.10)", async () => {
    const account = { address: "0xABCD", sendTransaction: vi.fn() } as any;
    await expect(bridgeUsdc(account, "eip155:8453", "eip155:42161", 0.05))
      .rejects.toThrow("Minimum bridge amount is $0.10 USDC");
  });

  it("throws if amountUsdc above maximum (> 50)", async () => {
    const account = { address: "0xABCD" } as any;
    await expect(bridgeUsdc(account, "eip155:8453", "eip155:42161", 51))
      .rejects.toThrow("Maximum bridge amount is $50 USDC");
  });

  it("throws for unsupported fromChain", async () => {
    const account = { address: "0xABCD" } as any;
    await expect(bridgeUsdc(account, "eip155:999", "eip155:8453", 1))
      .rejects.toThrow("Unsupported chain: eip155:999");
  });

  it("throws for unsupported toChain", async () => {
    const account = { address: "0xABCD" } as any;
    await expect(bridgeUsdc(account, "eip155:8453", "eip155:999", 1))
      .rejects.toThrow("Unsupported chain: eip155:999");
  });
});

describe("bridgeUsdc fetch error handling", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      text: async () => "rate limited by Li.Fi",
    }));
  });

  it("throws when Li.Fi quote returns non-OK", async () => {
    const account = { address: "0xABCD" } as any;
    await expect(bridgeUsdc(account, "eip155:8453", "eip155:42161", 1))
      .rejects.toThrow("Li.Fi quote failed: rate limited by Li.Fi");
  });
});

describe("bridgeUsdc missing transactionRequest", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "quote-123" }), // no transactionRequest
    }));
  });

  it("throws when Li.Fi quote has no transactionRequest", async () => {
    const account = { address: "0xABCD" } as any;
    await expect(bridgeUsdc(account, "eip155:8453", "eip155:42161", 1))
      .rejects.toThrow("No transactionRequest in Li.Fi quote");
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd /home/miquel/automaton-web4-SIGIL-conway-
pnpm test -- bridge
```
Expected: FAIL with "Cannot find module '../utilities/bridge.js'"

**Step 3: Implement `src/utilities/bridge.ts`**

```typescript
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
```

**Step 4: Run tests to verify they pass**

```bash
pnpm test -- bridge
```
Expected: 6 tests PASS

**Step 5: Commit**

```bash
git add src/utilities/bridge.ts src/__tests__/bridge.test.ts
git -c user.email="agatha@conway.tech" -c user.name="Agatha" commit -m "feat: add Li.Fi bridge utility for USDC cross-chain transfers"
```

---

### Task 2: `bridge_usdc` Agent Tool

**Files:**
- Modify: `src/agent/tools.ts` (add one tool entry before closing `]` of `createBuiltinTools`)
- Create: `src/__tests__/bridge-tool.test.ts`

**Step 1: Write the failing test**

```typescript
// src/__tests__/bridge-tool.test.ts
import { describe, it, expect } from "vitest";
import { createBuiltinTools } from "../agent/tools.js";

describe("bridge_usdc tool registration", () => {
  it("is registered in createBuiltinTools", () => {
    const tools = createBuiltinTools("test-sandbox");
    const tool = tools.find((t) => t.name === "bridge_usdc");
    expect(tool).toBeDefined();
  });

  it("has category 'financial'", () => {
    const tools = createBuiltinTools("test-sandbox");
    const tool = tools.find((t) => t.name === "bridge_usdc")!;
    expect(tool.category).toBe("financial");
  });

  it("requires fromChain, toChain, amountUsdc params", () => {
    const tools = createBuiltinTools("test-sandbox");
    const tool = tools.find((t) => t.name === "bridge_usdc")!;
    const required = (tool.parameters as any).required as string[];
    expect(required).toContain("fromChain");
    expect(required).toContain("toChain");
    expect(required).toContain("amountUsdc");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm test -- bridge-tool
```
Expected: FAIL with "tool is undefined"

**Step 3: Add `bridge_usdc` to `createBuiltinTools`**

In `src/agent/tools.ts`, find the line that reads `  ];` (the closing bracket of the tools array returned by `createBuiltinTools`, around line 1589-1590). Insert the following block **before** that closing `];`:

```typescript
    // ── Bridge Tool ──
    {
      name: "bridge_usdc",
      description:
        "Bridge USDC from one EVM chain to another via Li.Fi. " +
        "Supported chains: eip155:1 (Ethereum), eip155:137 (Polygon), eip155:42161 (Arbitrum), eip155:8453 (Base). " +
        "Max $50 per bridge, min $0.10. Takes ~5 minutes. Use when you need USDC on a specific chain.",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          fromChain: {
            type: "string",
            description: "Source chain ID (e.g. 'eip155:8453' for Base, 'eip155:42161' for Arbitrum)",
          },
          toChain: {
            type: "string",
            description: "Destination chain ID (e.g. 'eip155:42161' for Arbitrum, 'eip155:8453' for Base)",
          },
          amountUsdc: {
            type: "number",
            description: "Amount to bridge in human-readable USDC (e.g. 1.5 for $1.50)",
          },
        },
        required: ["fromChain", "toChain", "amountUsdc"],
      },
      execute: async (args, ctx) => {
        const { bridgeUsdc } = await import("../utilities/bridge.js");
        const fromChain = args.fromChain as string;
        const toChain   = args.toChain   as string;
        const amountUsdc = args.amountUsdc as number;
        console.log(`[bridge_usdc] Bridging ${amountUsdc} USDC from ${fromChain} → ${toChain}...`);
        try {
          const result = await bridgeUsdc(ctx.identity.account, fromChain, toChain, amountUsdc);
          return `✅ Bridge complete. txHash: ${result.txHash}. Received ~${result.toAmount} USDC on ${toChain}.`;
        } catch (err: any) {
          return `❌ Bridge failed: ${err.message}`;
        }
      },
    },
```

The `execute` function uses `ctx.identity.account` which is a `PrivateKeyAccount` (same type used in x402Fetch and other financial tools).

**Step 4: Run test to verify it passes**

```bash
pnpm test -- bridge-tool
```
Expected: 3 tests PASS

**Step 5: Run full test suite**

```bash
pnpm test
```
Expected: All existing tests still pass.

**Step 6: Commit**

```bash
git add src/agent/tools.ts src/__tests__/bridge-tool.test.ts
git -c user.email="agatha@conway.tech" -c user.name="Agatha" commit -m "feat: add bridge_usdc agent tool via Li.Fi"
```

---

### Task 3: Export Shared Chain Constants + Fix signPayment chainId

**Files:**
- Modify: `src/conway/x402.ts`
- Modify: `src/__tests__/x402-multichain.test.ts` (new test file)

**Context:** `CHAINS`, `USDC_ADDRESSES` and the inline `rpcUrls` in `checkNetworkBalance` are module-private. Task 4 needs them. Also, `signPayment` uses a hardcoded ternary for chainId at line 349.

**Step 1: Write the failing test**

```typescript
// src/__tests__/x402-multichain.test.ts
import { describe, it, expect } from "vitest";
import { CHAINS, USDC_ADDRESSES, RPC_URLS } from "../conway/x402.js";

describe("x402 exported chain constants", () => {
  it("exports CHAINS with Base and Arbitrum", () => {
    expect(CHAINS["eip155:8453"]).toBeDefined();
    expect(CHAINS["eip155:42161"]).toBeDefined();
  });

  it("exports USDC_ADDRESSES for all four mainnet chains", () => {
    expect(USDC_ADDRESSES["eip155:8453"]).toMatch(/^0x/);
    expect(USDC_ADDRESSES["eip155:42161"]).toMatch(/^0x/);
    expect(USDC_ADDRESSES["eip155:1"]).toMatch(/^0x/);
    expect(USDC_ADDRESSES["eip155:137"]).toMatch(/^0x/);
  });

  it("exports RPC_URLS for all four mainnet chains", () => {
    expect(RPC_URLS["eip155:8453"]).toContain("base");
    expect(RPC_URLS["eip155:42161"]).toContain("arb");
    expect(RPC_URLS["eip155:1"]).toBeDefined();
    expect(RPC_URLS["eip155:137"]).toBeDefined();
  });

  it("CHAINS entries have correct numeric chainId via .id", () => {
    expect(CHAINS["eip155:8453"].id).toBe(8453);
    expect(CHAINS["eip155:42161"].id).toBe(42161);
    expect(CHAINS["eip155:1"].id).toBe(1);
    expect(CHAINS["eip155:137"].id).toBe(137);
  });
});
```

**Step 2: Run to verify failure**

```bash
pnpm test -- x402-multichain
```
Expected: FAIL with "does not provide an export named 'CHAINS'"

**Step 3: Update `src/conway/x402.ts`**

Make three changes:

**3a.** Add `export` to the two existing consts (lines 19 and 27):

```typescript
// Before (line 19):
const USDC_ADDRESSES: Record<string, Address> = {

// After:
export const USDC_ADDRESSES: Record<string, Address> = {
```

```typescript
// Before (line 27):
const CHAINS: Record<string, any> = {

// After:
export const CHAINS: Record<string, any> = {
```

**3b.** Lift `rpcUrls` out of `checkNetworkBalance` to module level and export it. Remove the inline definition inside `checkNetworkBalance` and replace its reference:

Add this new export **after the `CHAINS` const** (around line 33):

```typescript
export const RPC_URLS: Record<string, string> = {
  "eip155:42161": "https://arb-mainnet.g.alchemy.com/v2/OzJPWxPbbiSE_ug5Vi0vq",
  "eip155:8453":  "https://mainnet.base.org",
  "eip155:1":     "https://eth.drpc.org",
  "eip155:137":   "https://polygon-rpc.com",
  "eip155:84532": "https://sepolia.base.org",
};
```

Then remove the local `rpcUrls` const inside `checkNetworkBalance` (the block at lines ~79-86) and update the `createPublicClient` call to use `RPC_URLS`:

```typescript
// Remove this block (lines ~79-86):
const rpcUrls: Record<string, string> = {
  "eip155:42161": "https://arb-mainnet.g.alchemy.com/v2/OzJPWxPbbiSE_ug5Vi0vq",
  ...
};

// And update the transport line from:
transport: http(rpcUrls[network]),
// To:
transport: http(RPC_URLS[network]),
```

**3c.** Fix `signPayment` chainId (around line 349). Replace:

```typescript
chainId: requirement.network === "eip155:84532" ? 84532 : 8453,
```

With:

```typescript
chainId: CHAINS[requirement.network]?.id ?? 8453,
```

**Step 4: Run tests**

```bash
pnpm test -- x402-multichain
```
Expected: 4 tests PASS

```bash
pnpm test
```
Expected: All tests pass (no regressions).

**Step 5: Commit**

```bash
git add src/conway/x402.ts src/__tests__/x402-multichain.test.ts
git -c user.email="agatha@conway.tech" -c user.name="Agatha" commit -m "feat: export CHAINS/USDC_ADDRESSES/RPC_URLS from x402, fix signPayment chainId"
```

---

### Task 4: Multi-Chain Task Handler + Server

**Files:**
- Modify: `src/relay/task-handler.ts`
- Modify: `src/relay/server.ts`
- Create: `src/__tests__/task-handler-multichain.test.ts`

**Context:** `task-handler.ts` has a hardcoded `USDC_BASE` const and `BASE_RPC` const at the top (~line 107-108 and 160). `verifyAndSettlePayment` uses these unconditionally. `buildPaymentRequired` returns a single Base entry. Server.ts calls `buildPaymentRequired` synchronously at line 229.

**Step 1: Write the failing tests**

```typescript
// src/__tests__/task-handler-multichain.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initPricingSchema, buildPaymentRequired } from "../relay/task-handler.js";
import * as x402 from "../conway/x402.js";

describe("buildPaymentRequired multi-chain", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(":memory:");
    initPricingSchema(db);
  });

  it("returns only Base when no other chain has balance", async () => {
    vi.spyOn(x402, "getUsdcBalance").mockImplementation(async (_addr, network) => {
      return network === "eip155:8453" ? 1.0 : 0;
    });
    const result = await buildPaymentRequired("shell", "0xDEAD" as any, db);
    expect(result.accepts.length).toBe(1);
    expect(result.accepts[0].network).toBe("eip155:8453");
    vi.restoreAllMocks();
  });

  it("returns multiple chains when all have balance", async () => {
    vi.spyOn(x402, "getUsdcBalance").mockResolvedValue(2.0);
    const result = await buildPaymentRequired("shell", "0xDEAD" as any, db);
    expect(result.accepts.length).toBeGreaterThan(1);
    const networks = result.accepts.map((a) => a.network);
    expect(networks).toContain("eip155:8453");
    expect(networks).toContain("eip155:42161");
    vi.restoreAllMocks();
  });

  it("falls back to Base-only when all balances are 0", async () => {
    vi.spyOn(x402, "getUsdcBalance").mockResolvedValue(0);
    const result = await buildPaymentRequired("shell", "0xDEAD" as any, db);
    expect(result.accepts.length).toBe(1);
    expect(result.accepts[0].network).toBe("eip155:8453");
    vi.restoreAllMocks();
  });

  it("each accept entry has the correct USDC asset address for its chain", async () => {
    vi.spyOn(x402, "getUsdcBalance").mockImplementation(async (_addr, network) => {
      return network === "eip155:42161" ? 1.0 : 0;
    });
    const result = await buildPaymentRequired("shell", "0xDEAD" as any, db);
    const arb = result.accepts.find((a) => a.network === "eip155:42161");
    expect(arb?.asset).toBe(x402.USDC_ADDRESSES["eip155:42161"]);
    vi.restoreAllMocks();
  });
});
```

**Step 2: Run to verify failure**

```bash
pnpm test -- task-handler-multichain
```
Expected: FAIL with "buildPaymentRequired is not async" or type errors

**Step 3: Update `src/relay/task-handler.ts`**

**3a.** Add imports at the top. After the existing viem imports, add:

```typescript
import { CHAINS, USDC_ADDRESSES, RPC_URLS, getUsdcBalance } from "../conway/x402.js";
```

**3b.** Remove the two hardcoded constants near line 107 and 160:

```typescript
// Remove these:
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const BASE_RPC = "https://mainnet.base.org";
```

**3c.** Update the `PaymentRequiredBody` interface to match multi-chain:

```typescript
interface PaymentRequiredBody {
  accepts: Array<{
    scheme: string;
    network: string;
    maxAmountRequired: string;
    payToAddress: Address;
    asset: Address;
    maxTimeoutSeconds: number;
    resource: string;
  }>;
}
```

(No change needed — same shape, just more entries.)

**3d.** Replace `buildPaymentRequired` with an async version:

```typescript
export async function buildPaymentRequired(
  taskType: string,
  payToAddress: Address,
  db: InstanceType<typeof Database>,
): Promise<PaymentRequiredBody> {
  const amount = getCurrentPricing(db, taskType);

  const supportedNetworks = ["eip155:8453", "eip155:42161", "eip155:1", "eip155:137"];

  // Check which chains have USDC balance (in parallel)
  const balances = await Promise.all(
    supportedNetworks.map(async (network) => {
      try {
        const bal = await getUsdcBalance(payToAddress, network);
        return bal > 0 ? network : null;
      } catch {
        return null;
      }
    }),
  );
  const fundedNetworks = balances.filter(Boolean) as string[];
  const activeNetworks = fundedNetworks.length > 0 ? fundedNetworks : ["eip155:8453"];

  return {
    accepts: activeNetworks.map((network) => ({
      scheme: "exact",
      network,
      maxAmountRequired: amount.toString(),
      payToAddress,
      asset: USDC_ADDRESSES[network] as Address,
      maxTimeoutSeconds: 300,
      resource: "POST /v1/tasks",
    })),
  };
}
```

**3e.** Update `verifyAndSettlePayment` to use the payment's network. Replace the hardcoded chain/address block:

Find these lines inside `verifyAndSettlePayment`:
```typescript
// (existing) around line 217-235:
const walletClient = createWalletClient({ account, chain: base, transport: http(BASE_RPC) });
const publicClient = createPublicClient({ chain: base, transport: http(BASE_RPC) });

const hash = await walletClient.writeContract({
  address: USDC_BASE,
```

Replace with:
```typescript
const network = payment.network ?? "eip155:8453";
const chain   = CHAINS[network] ?? CHAINS["eip155:8453"];
const rpcUrl  = RPC_URLS[network] ?? RPC_URLS["eip155:8453"];
const usdcAddress = (USDC_ADDRESSES[network] ?? USDC_ADDRESSES["eip155:8453"]) as Address;

const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

const hash = await walletClient.writeContract({
  address: usdcAddress,
```

Also remove the `import { base } from "viem/chains"` if `base` is no longer referenced directly. Check the import line at the top of task-handler.ts and remove `base` from it.

**Step 4: Update `src/relay/server.ts`**

Find line ~229:
```typescript
const req402 = buildPaymentRequired(type, account.address, db);
```

Replace with:
```typescript
const req402 = await buildPaymentRequired(type, account.address, db);
```

**Step 5: Run tests**

```bash
pnpm test -- task-handler-multichain
```
Expected: 4 tests PASS

```bash
pnpm test
```
Expected: All tests pass.

**Step 6: Commit**

```bash
git add src/relay/task-handler.ts src/relay/server.ts src/__tests__/task-handler-multichain.test.ts
git -c user.email="agatha@conway.tech" -c user.name="Agatha" commit -m "feat: multi-chain 402 offers and settlement in task handler"
```

---

### Task 5: Multi-Chain Capability Announcement

**Files:**
- Modify: `src/index.ts`
- Modify: `src/agent/system-prompt.ts`
- Create: `src/__tests__/announcement.test.ts`

**Context:** `src/index.ts` builds the agent-card.json in two code paths (try/catch). Both need `capabilities` and `networks` fields. `OPERATIONAL_CONTEXT` in `system-prompt.ts` mentions x402 but not multi-chain.

**Step 1: Write the failing test**

```typescript
// src/__tests__/announcement.test.ts
import { describe, it, expect } from "vitest";
import { OPERATIONAL_CONTEXT_MULTICHAIN } from "../agent/system-prompt.js";

describe("multi-chain announcement in OPERATIONAL_CONTEXT", () => {
  it("mentions Ethereum chain", () => {
    expect(OPERATIONAL_CONTEXT_MULTICHAIN).toContain("eip155:1");
  });

  it("mentions Arbitrum chain", () => {
    expect(OPERATIONAL_CONTEXT_MULTICHAIN).toContain("eip155:42161");
  });

  it("mentions Base chain", () => {
    expect(OPERATIONAL_CONTEXT_MULTICHAIN).toContain("eip155:8453");
  });

  it("mentions Polygon chain", () => {
    expect(OPERATIONAL_CONTEXT_MULTICHAIN).toContain("eip155:137");
  });
});
```

**Step 2: Run to verify failure**

```bash
pnpm test -- announcement
```
Expected: FAIL with "does not provide an export named 'OPERATIONAL_CONTEXT_MULTICHAIN'"

**Step 3a: Update `src/agent/system-prompt.ts`**

Find this line in `OPERATIONAL_CONTEXT` (around line 94):
```typescript
- Make USDC payments via x402 protocol
```

Replace with:
```typescript
- Make and accept USDC payments via x402 protocol on any major EVM chain (Ethereum eip155:1, Polygon eip155:137, Arbitrum eip155:42161, Base eip155:8453)
```

Then export the constant so the test can import it. Add at the bottom of the file (after all existing exports):

```typescript
/**
 * Exported for testing — the multi-chain mention in OPERATIONAL_CONTEXT.
 * Do not use directly; `buildSystemPrompt` includes it automatically.
 */
export const OPERATIONAL_CONTEXT_MULTICHAIN = OPERATIONAL_CONTEXT;
```

**Step 3b: Update `src/index.ts` — agent-card.json**

There are two places in `src/index.ts` where agent-card.json is written.

**Path A (try block, ~line 211–232):** The `card` is read from file and services are updated. After updating the `tasksEndpoint` object (around line 221), add:

```typescript
// Update capabilities to declare multi-chain support
card.capabilities = [
  "evm:eip155:1",
  "evm:eip155:137",
  "evm:eip155:42161",
  "evm:eip155:8453",
];
// Add networks to tasks service entry
const tasksEndpoint = {
  name: "tasks",
  endpoint: `${config.relayPublicUrl}/v1/tasks`,
  pricing: { shell: "0.01 USDC", inference: "0.05 USDC" },
  networks: ["eip155:1", "eip155:137", "eip155:42161", "eip155:8453"],
};
```

(The `networks` field is on the `tasksEndpoint` object already defined there — just add the `networks` key to it.)

**Path B (catch block, ~line 235–253):** The new card object literal. Add `capabilities` field and `networks` to the tasks service:

```typescript
const card = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: config.name,
  description: `Autonomous agent. Creator: ${config.creatorAddress}.`,
  capabilities: [
    "evm:eip155:1",
    "evm:eip155:137",
    "evm:eip155:42161",
    "evm:eip155:8453",
  ],
  services: [
    { name: "relay", endpoint: config.relayPublicUrl },
    { name: "agentWallet", endpoint: `eip155:8453:${account.address}` },
    { name: "conway", endpoint: config.conwayApiUrl },
    {
      name: "tasks",
      endpoint: `${config.relayPublicUrl}/v1/tasks`,
      pricing: { shell: "0.01 USDC", inference: "0.05 USDC" },
      networks: ["eip155:1", "eip155:137", "eip155:42161", "eip155:8453"],
    },
  ],
  x402Support: true,
  active: true,
  parentAgent: config.creatorAddress,
};
```

**Step 4: Run tests**

```bash
pnpm test -- announcement
```
Expected: 4 tests PASS

```bash
pnpm test
```
Expected: All tests pass.

**Step 5: Commit**

```bash
git add src/agent/system-prompt.ts src/index.ts src/__tests__/announcement.test.ts
git -c user.email="agatha@conway.tech" -c user.name="Agatha" commit -m "feat: announce multi-chain EVM capability in agent card and system prompt"
```
