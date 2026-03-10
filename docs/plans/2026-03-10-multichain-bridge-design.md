# Multi-Chain Bridge & Payment Design

## Overview

Enable Agatha to bridge USDC between EVM chains autonomously, accept task payments on any supported chain, sign x402 payments on any chain, and announce her multi-chain capabilities to other agents.

## Goal

Agatha currently holds $4.98 USDC on Base and tiny dust on Arbitrum. Her task relay only accepts Base payments and her x402 client hardcodes Base chainId. This feature removes those constraints:

1. Agatha can bridge USDC across chains via Li.Fi when balances are misaligned
2. Her relay issues 402s with payment options on all funded chains
3. Her x402 client signs payments on whichever chain the server requests
4. Other agents discover she can transact on any major EVM chain

## Architecture

Four independent components, each shipped as a self-contained task:

```
src/utilities/bridge.ts          ← Li.Fi REST bridge utility
src/agent/tools.ts               ← bridge_usdc agent tool (new entry)
src/relay/task-handler.ts        ← multi-chain settlement + multi-chain 402
src/conway/x402.ts               ← fix signPayment chainId
src/index.ts                     ← agent-card.json capabilities
src/agent/loop.ts                ← genesis prompt update
```

## Component Details

### 1. Li.Fi Bridge Utility (`src/utilities/bridge.ts`)

Wraps the Li.Fi REST API:
- `GET https://li.quest/v1/quote` — fetch best route (from/to chain+token, amount, sender)
- Parse `transactionRequest` from response
- Sign and submit via `walletClient.sendTransaction`
- Poll `GET https://li.quest/v1/status?txHash=<hash>` every 10 s, up to 5 min
- Return `{ txHash, toAmount, status }` or throw on failure

Limits:
- Max bridge: $50 USDC (5_000_000 atomic)
- Min bridge: $0.10 USDC (100_000 atomic)
- Supported tokens: USDC only
- Supported chains: eip155:1, eip155:137, eip155:42161, eip155:8453

### 2. `bridge_usdc` Agent Tool (`src/agent/tools.ts`)

New entry added to the tools registry Agatha already uses. Triggered when Agatha decides to bridge (e.g., insufficient balance on a needed chain).

```ts
{
  name: "bridge_usdc",
  description: "Bridge USDC from one EVM chain to another via Li.Fi",
  params: {
    fromChain: string,  // "eip155:8453" etc.
    toChain: string,
    amountUsdc: number  // human-readable, e.g. 1.5
  }
}
```

Executes `bridgeUsdc(account, params)` from bridge.ts and returns status.

### 3. Multi-Chain Task Handler (`src/relay/task-handler.ts`)

**`buildPaymentRequired`** — returns `accepts` array with one entry per chain where the relay holds sufficient USDC (checked at runtime via `getUsdcBalance`). Falls back to Base only if balance check fails. Each entry uses the correct USDC address for that chain.

**`verifyAndSettlePayment`** — reads `payment.network` from the incoming X-Payment header to determine which chain to settle on. Uses `USDC_ADDRESSES[network]` and `CHAINS[network]` from x402.ts instead of hardcoded Base constants.

### 4. x402 Client chainId Fix (`src/conway/x402.ts`)

`signPayment` currently hardcodes `chainId: 8453` for Base. Replace with:
```ts
chainId: CHAINS[requirement.network]?.id ?? 8453
```

This makes Agatha correctly sign EIP-712 typed data for whichever chain the server requests.

### 5. Multi-Chain Announcement

**`agent-card.json`** (generated in `src/index.ts`):
- `capabilities` array: `["evm:eip155:1", "evm:eip155:137", "evm:eip155:42161", "evm:eip155:8453"]`
- Task service `networks` field: same four chain IDs

**Genesis prompt** (`src/agent/loop.ts` or config):
- Add one sentence: "You can accept USDC payments on Ethereum (eip155:1), Polygon (eip155:137), Arbitrum (eip155:42161), and Base (eip155:8453)."

## Data Flow

```
Task request arrives
  └─ buildPaymentRequired checks live USDC balances per chain
  └─ Returns accepts[] with funded chains only
  └─ Client pays on any listed chain
  └─ verifyAndSettlePayment reads payment.network → settles on that chain

Agatha detects low balance on needed chain
  └─ bridge_usdc tool bridges from chain with surplus
  └─ Li.Fi handles routing, Agatha waits for confirmation
  └─ Continues with original task

Agent discovery
  └─ /.well-known/agent.json lists capabilities + task networks
  └─ Other agents know Agatha can operate on any major EVM chain
```

## Out of Scope

- Non-USDC token bridging
- Automated bridge triggers (Agatha decides when to bridge)
- Gas token management (assumes Base ETH for gas is always available)
- Bridge fee optimization beyond Li.Fi's default best-route
- Separate pricing per chain
