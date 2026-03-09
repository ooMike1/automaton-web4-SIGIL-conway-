# Dynamic Pricing for Task Agent — Design

## Overview

Replace hardcoded `TASK_PRICING` constants with a conversion-rate-driven pricing engine. Agatha raises prices when demand is strong, lowers them when demand dries up — maximising revenue while maintaining enough throughput to keep earning.

## Goal

Maximize revenue per unit time by finding the highest price the market will bear. No hard price ceiling.

## Pricing Algorithm

Every 30 minutes, for each task type (`shell`, `inference`):

1. Count events in the last hour from `pricing_events` table: `issued` (402 responses) and `paid` (completed payments)
2. Skip adjustment if fewer than 3 total events (insufficient data)
3. `conversion = paid / issued`
4. Apply multiplier:
   - `conversion > 0.8` → `price *= 1.25` (strong demand, push up)
   - `conversion < 0.2` → `price *= 0.85` (weak demand, come down)
   - Otherwise → hold
5. Clamp to floor: shell ≥ 10,000 atomic USDC ($0.01), inference ≥ 50,000 ($0.05)
6. Write new price to `pricing_state`, log the adjustment

On startup: load prices from `pricing_state`. Fall back to floor defaults if table is empty.

## Data Model

Two new tables in `relay.db`:

```sql
CREATE TABLE pricing_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_type  TEXT NOT NULL,   -- 'shell' | 'inference'
  event      TEXT NOT NULL,   -- '402' | 'paid'
  price      INTEGER NOT NULL, -- atomic USDC at time of event
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE pricing_state (
  task_type  TEXT PRIMARY KEY,
  price      INTEGER NOT NULL
);
```

## Components

### `src/relay/task-handler.ts` (modify)

- Replace `TASK_PRICING` constant with `getCurrentPricing(db, taskType): bigint`
- Add `recordPricingEvent(db, taskType, event, price): void`
- Add `startPricingEngine(db): () => void` — 30-min interval, returns stop function

### `src/relay/server.ts` (modify)

- Call `startPricingEngine(db)` on server start; store stop function for cleanup
- Pass `db` to `buildPaymentRequired` and settlement handler
- Record `'402'` event when issuing 402 response
- Record `'paid'` event after successful `verifyAndSettlePayment`

### Public API changes

| Function | Before | After |
|---|---|---|
| `buildPaymentRequired` | `(taskType, payToAddress)` | `(taskType, payToAddress, db)` |
| `startPricingEngine` | — | `(db): () => void` (new) |
| `getCurrentPricing` | — | `(db, taskType): bigint` (new) |
| `recordPricingEvent` | — | `(db, taskType, event, price): void` (new) |

## Data Flow

```
Request arrives
  └─ getCurrentPricing(db, type) → live price
  └─ No X-Payment → recordPricingEvent('402', price) → 402 response
  └─ X-Payment present → verifyAndSettlePayment(...)
       └─ ok → recordPricingEvent('paid', price) → execute → 200
       └─ fail → 402 error (no event recorded)

Every 30 min:
  pricing engine reads last-hour events
  computes conversion rate
  adjusts pricing_state
  logs: "[PRICING] shell: $0.01 → $0.0125 (conv: 0.83)"
```

## Out of Scope

- Separate prices per caller identity
- Manual price override via API
- Pricing history endpoint
- Cross-restart nonce deduplication (existing in-process Set is sufficient)
