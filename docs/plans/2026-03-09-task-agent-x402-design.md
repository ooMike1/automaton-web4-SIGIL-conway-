# Task Agent with x402 Payment — Design

## Overview

Add a `POST /v1/tasks` endpoint to Agatha's relay server that accepts paid task requests from humans or other agents. Payment is collected via x402 (EIP-3009 `transferWithAuthorization`) in USDC on Base before any task is executed.

## Endpoint

```
POST /v1/tasks
Content-Type: application/json
Body: { "type": "shell" | "inference", "input": "<task input>" }
```

**Without X-Payment header → 402:**
```json
{
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:8453",
    "maxAmountRequired": "10000",
    "payToAddress": "0x0B864EC2...",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "maxTimeoutSeconds": 300,
    "resource": "POST /v1/tasks"
  }]
}
```

**With valid X-Payment header → settle + execute → 200:**
```json
{ "result": "...", "type": "shell", "cost": "0.01 USDC" }
```

## Pricing

| Task type   | Cost (USDC) | Atomic units |
|-------------|-------------|--------------|
| `shell`     | $0.01       | 10000        |
| `inference` | $0.05       | 50000        |

## Components

### 1. `src/relay/task-handler.ts` (new)
- `buildPaymentRequired(taskType)` — builds the 402 response body
- `verifyAndSettlePayment(paymentHeader, taskType, agentAccount)` — decodes X-Payment, calls `USDC.transferWithAuthorization()` on Base, returns tx hash or error
- `executeTask(type, input, config)` — dispatches to shell or inference executor

### 2. Shell executor
- Uses `execFileNoThrow` (safe, no shell injection)
- Parse input as `{ command: string, args: string[] }` or plain string split by whitespace
- Allowlist of permitted commands: `ls`, `cat`, `grep`, `find`, `python3`, `node`, `curl`, `echo`, `wc`, `head`, `tail`, `jq`, `date`
- Block paths: `/etc`, `/root`, `~/.automaton/wallet.json`
- 30s timeout

### 3. Inference executor
- POST to Conway API (`/v1/chat/completions`) with `gpt-4.1-nano`
- 500 token output cap to keep cost predictable

### 4. Payment settlement
- Decode `X-Payment` base64 header → `{ payload: { authorization, signature } }`
- Call `USDC.transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s)` on Base via viem `walletClient.writeContract`
- If tx reverts → return 402 (do not execute)
- If tx succeeds → execute task

### 5. `src/relay/server.ts` — wire new handler
- Add `POST /v1/tasks` before the 404 catch-all
- Pass `agentAccount` (wallet) into relay options

### 6. `agent-card.json` — add tasks section
```json
{
  "services": [
    { "name": "tasks", "endpoint": "<relayPublicUrl>/v1/tasks",
      "pricing": { "shell": "0.01 USDC", "inference": "0.05 USDC" } }
  ]
}
```

## Data Flow

```
Client                          Agatha Relay (port 3701)           Base chain
  |                                      |                              |
  |- POST /v1/tasks ------------------->|                              |
  |  { type, input }                     |                              |
  |<- 402 + X-Payment-Required ----------|                              |
  |                                      |                              |
  |  (client signs EIP-712 authorization)|                              |
  |                                      |                              |
  |- POST /v1/tasks ------------------->|                              |
  |  X-Payment: <base64>                 |- transferWithAuthorization ->|
  |                                      |<- tx receipt ----------------|
  |                                      |- execute task                |
  |<- 200 { result } -------------------|                              |
```

## Error Handling

- Invalid/expired payment signature → 402
- transferWithAuthorization reverts → 402
- Command not in allowlist → 400
- Shell timeout → 408
- Inference API error → 500 (known v1 limitation: payment already settled)

## Out of scope (v1)

- Refunds
- Async task delivery via webhook
- Per-client rate limiting
- Task history/receipts endpoint
