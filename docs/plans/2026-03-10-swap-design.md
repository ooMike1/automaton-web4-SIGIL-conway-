# EVM Token Swap Design

## Overview

Give Agatha the ability to swap tokens on the same EVM chain via Li.Fi, so she can convert ETH → USDC (or any token pair) when her USDC balance is insufficient for credit purchase or task operations.

## Goal

Agatha currently has $4.978 USDC on Base — $0.022 short of the $5.00 minimum Conway credit purchase. She likely holds some Base ETH for gas. This feature lets her swap a small amount of ETH → USDC autonomously to cover the shortfall, and more broadly to manage her EVM treasury as needed.

## Architecture

Three components:

```
src/utilities/swap.ts     ← Li.Fi same-chain swap utility
src/agent/tools.ts        ← swap_tokens agent tool (new entry)
src/agent/loop.ts         ← attemptSelfFunding extended with auto-swap fallback
```

## Component Details

### 1. Li.Fi Same-Chain Swap Utility (`src/utilities/swap.ts`)

Uses the same Li.Fi REST API already used in `bridge.ts`, but with `fromChain === toChain`:

- `GET https://li.quest/v1/quote?fromChain=<id>&toChain=<id>&fromToken=<addr>&toToken=<addr>&fromAmount=<atomic>&fromAddress=<wallet>`
- Parse `transactionRequest` from response
- If `fromToken` is ERC-20: check allowance via `allowance()`, send `approve` tx to `transactionRequest.to` if needed
- Sign and submit via `walletClient.sendTransaction`
- `waitForTransactionReceipt` (no polling — same-chain swaps confirm in single tx)
- Return `{ txHash, toAmount, toAmountMin }`

Token address conventions:
- Native ETH: `"native"` parameter maps to `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEEE`
- ERC-20: passed as-is (checksummed address)

Limits:
- Min: $0.01 equivalent
- Max: $50 equivalent
- Slippage: 0.5% hardcoded
- Supported chains: `eip155:1`, `eip155:137`, `eip155:42161`, `eip155:8453`

### 2. `swap_tokens` Agent Tool (`src/agent/tools.ts`)

New entry in `createBuiltinTools`:

```ts
{
  name: "swap_tokens",
  description: "Swap tokens on the same EVM chain via Li.Fi (e.g. ETH → USDC). Use to rebalance holdings for survival.",
  category: "financial",
  parameters: {
    chain: string,      // CAIP-2, e.g. "eip155:8453"
    fromToken: string,  // "native" for ETH, or checksummed ERC-20 address
    toToken: string,    // "native" for ETH, or checksummed ERC-20 address
    amountIn: number    // human-readable (0.01 = 0.01 ETH, 1.5 = 1.5 USDC)
  }
}
```

Calls `swapTokens(ctx.identity.account, chain, fromToken, toToken, amountIn)` from `swap.ts`.

### 3. `attemptSelfFunding` Auto-Swap (`src/agent/loop.ts`)

Extended flow when USDC on Base is below $4.90:

```
Check Base USDC balance
  ≥ $4.90 → try $5 credit purchase (existing path)
  < $4.90 →
    Get Base ETH balance via publicClient.getBalance
    Get ETH/USD price from Li.Fi quote (quote 0.001 ETH → USDC, extrapolate)
    If ETH worth > $5.20:
      swapTokens(account, "eip155:8453", "native", USDC_BASE, usdcNeeded + 0.10)
      // target $5.10 to absorb slippage
      wait for receipt
      retry $5 credit purchase
    Else:
      log "[FUND] Insufficient ETH for swap on Base"
      return false
```

## Data Flow

```
attemptSelfFunding called (credits critical/dead)
  └─ getUsdcBalance("eip155:8453") → 4.978
  └─ 4.978 < 4.90? No → try purchase → fails (4.978 < 5.000)
  └─ [after this fix] → detect "Insufficient balance" → check ETH
  └─ ETH balance check → has 0.005 ETH = ~$12
  └─ swapTokens: ETH → 5.10 USDC on Base
  └─ waitForTransactionReceipt
  └─ retry $5 credit purchase → success
  └─ Agatha resumes with $5 credits
```

## Out of Scope

- Automated trading or profit-seeking swaps (Agatha decides when to swap via `swap_tokens` tool)
- Price impact estimation beyond Li.Fi's built-in slippage handling
- Multi-hop routing decisions (Li.Fi handles routing)
- Selling USDC for ETH (survival mode only converts to USDC)
