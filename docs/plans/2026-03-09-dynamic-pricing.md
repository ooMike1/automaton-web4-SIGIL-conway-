# Dynamic Pricing Engine Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace hardcoded `TASK_PRICING` with a live pricing engine that raises prices when demand is strong and lowers them when it drops — maximising Agatha's revenue with no ceiling.

**Architecture:** Two new SQLite tables in `relay.db` track pricing events and current state. A 30-minute interval loop reads conversion rate (paid / issued) from the last hour and adjusts prices. `getCurrentPricing(db, taskType)` replaces the hardcoded constant at every 402 response point. `recordPricingEvent` writes one row per 402 issued and per successful payment.

**Tech Stack:** TypeScript, better-sqlite3 (already a dependency), vitest.

---

### Task 1: DB schema — pricing_events and pricing_state

**Files:**
- Modify: `src/relay/server.ts` (lines 59-73 — DB init block)
- Test: `src/__tests__/pricing.test.ts` (new)

**Context:** `server.ts` creates `relay.db` and runs `CREATE TABLE IF NOT EXISTS` for `messages`. We add two more tables in the same block.

**Step 1: Write the failing test**

Create `src/__tests__/pricing.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initPricingSchema } from "../relay/task-handler.js";

describe("Pricing DB schema", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(":memory:");
    initPricingSchema(db);
  });

  it("creates pricing_events table", () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pricing_events'"
    ).get();
    expect(row).toBeTruthy();
  });

  it("creates pricing_state table", () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pricing_state'"
    ).get();
    expect(row).toBeTruthy();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd /home/miquel/automaton-web4-SIGIL-conway- && npm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|PASS|pricing)" | head -10
```
Expected: FAIL — `initPricingSchema is not a function`

**Step 3: Add `initPricingSchema` to task-handler.ts**

At the top of `src/relay/task-handler.ts`, after the existing imports, add:

```typescript
import type Database from "better-sqlite3";

export function initPricingSchema(db: InstanceType<typeof Database>): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS pricing_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_type  TEXT NOT NULL,
      event      TEXT NOT NULL,
      price      INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS pricing_state (
      task_type  TEXT PRIMARY KEY,
      price      INTEGER NOT NULL
    )
  `).run();
}
```

**Step 4: Call `initPricingSchema` in server.ts**

In `src/relay/server.ts`, update the import from `./task-handler.js` to include `initPricingSchema`:

```typescript
import {
  buildPaymentRequired,
  verifyAndSettlePayment,
  executeTask,
  TASK_PRICING,
  initPricingSchema,
} from "./task-handler.js";
```

Then after line 73 (`db.prepare("CREATE INDEX IF NOT EXISTS...").run();`), add:

```typescript
  initPricingSchema(db);
```

**Step 5: Run tests to verify they pass**

```bash
cd /home/miquel/automaton-web4-SIGIL-conway- && npm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|PASS|✓|✗|pricing)" | head -20
```
Expected: `✓ creates pricing_events table`, `✓ creates pricing_state table`

**Step 6: Build**

```bash
cd /home/miquel/automaton-web4-SIGIL-conway- && npm run build 2>&1 | grep -E "error TS" | head -5
```
Expected: no output.

**Step 7: Commit**

```bash
cd /home/miquel/automaton-web4-SIGIL-conway- && git add src/relay/task-handler.ts src/relay/server.ts src/__tests__/pricing.test.ts && git -c user.email="agatha@conway.tech" -c user.name="Agatha" commit -m "feat: pricing DB schema — pricing_events and pricing_state tables"
```

---

### Task 2: getCurrentPricing and recordPricingEvent

**Files:**
- Modify: `src/relay/task-handler.ts`
- Modify: `src/__tests__/pricing.test.ts`

**Context:** `TASK_PRICING` holds the floor prices. `getCurrentPricing` reads from `pricing_state`, falling back to the floor if no row exists. `recordPricingEvent` inserts one row per event.

**Step 1: Write failing tests**

Append to `src/__tests__/pricing.test.ts`:

```typescript
import { getCurrentPricing, recordPricingEvent, TASK_PRICING } from "../relay/task-handler.js";

describe("getCurrentPricing", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(":memory:");
    initPricingSchema(db);
  });

  it("returns floor price when no state exists", () => {
    expect(getCurrentPricing(db, "shell")).toBe(TASK_PRICING.shell);
    expect(getCurrentPricing(db, "inference")).toBe(TASK_PRICING.inference);
  });

  it("returns stored price when state exists", () => {
    db.prepare("INSERT INTO pricing_state (task_type, price) VALUES (?, ?)").run("shell", 25000);
    expect(getCurrentPricing(db, "shell")).toBe(25_000n);
  });
});

describe("recordPricingEvent", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(":memory:");
    initPricingSchema(db);
  });

  it("inserts a pricing event row", () => {
    recordPricingEvent(db, "shell", "402", 10_000n);
    const row = db.prepare("SELECT * FROM pricing_events").get() as any;
    expect(row.task_type).toBe("shell");
    expect(row.event).toBe("402");
    expect(row.price).toBe(10000);
  });
});
```

**Step 2: Run to verify they fail**

```bash
cd /home/miquel/automaton-web4-SIGIL-conway- && npm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|✗|getCurrentPricing|recordPricing)" | head -10
```
Expected: FAIL — functions not exported yet.

**Step 3: Add the functions to task-handler.ts**

After `initPricingSchema`, add:

```typescript
const PRICING_FLOORS: Record<string, bigint> = {
  shell:     10_000n,
  inference: 50_000n,
};

export function getCurrentPricing(db: InstanceType<typeof Database>, taskType: string): bigint {
  const row = db.prepare("SELECT price FROM pricing_state WHERE task_type = ?").get(taskType) as { price: number } | undefined;
  if (row) return BigInt(row.price);
  return PRICING_FLOORS[taskType] ?? PRICING_FLOORS.shell;
}

export function recordPricingEvent(
  db: InstanceType<typeof Database>,
  taskType: string,
  event: "402" | "paid",
  price: bigint,
): void {
  db.prepare(
    "INSERT INTO pricing_events (task_type, event, price) VALUES (?, ?, ?)"
  ).run(taskType, event, Number(price));
}
```

**Step 4: Run tests to verify they pass**

```bash
cd /home/miquel/automaton-web4-SIGIL-conway- && npm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|PASS|✓|✗)" | head -20
```
Expected: all pricing tests pass.

**Step 5: Build**

```bash
cd /home/miquel/automaton-web4-SIGIL-conway- && npm run build 2>&1 | grep -E "error TS" | head -5
```

**Step 6: Commit**

```bash
cd /home/miquel/automaton-web4-SIGIL-conway- && git add src/relay/task-handler.ts src/__tests__/pricing.test.ts && git -c user.email="agatha@conway.tech" -c user.name="Agatha" commit -m "feat: getCurrentPricing and recordPricingEvent"
```

---

### Task 3: startPricingEngine — the adjustment loop

**Files:**
- Modify: `src/relay/task-handler.ts`
- Modify: `src/__tests__/pricing.test.ts`

**Context:** Every 30 minutes, for each task type, reads last hour's events, computes conversion rate, applies multiplier, clamps to floor, saves to `pricing_state`. Returns a stop function.

**Step 1: Write failing test**

Append to `src/__tests__/pricing.test.ts`:

```typescript
import { startPricingEngine } from "../relay/task-handler.js";

describe("pricing engine adjustment", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(":memory:");
    initPricingSchema(db);
  });

  it("raises price when conversion > 0.8", () => {
    // 5 issued, 5 paid — 100% conversion
    for (let i = 0; i < 5; i++) {
      db.prepare("INSERT INTO pricing_events (task_type, event, price, created_at) VALUES (?, ?, ?, datetime('now'))").run("shell", "402", 10000);
      db.prepare("INSERT INTO pricing_events (task_type, event, price, created_at) VALUES (?, ?, ?, datetime('now'))").run("shell", "paid", 10000);
    }
    // Run one adjustment cycle directly
    runPricingAdjustment(db);
    const newPrice = getCurrentPricing(db, "shell");
    expect(newPrice).toBeGreaterThan(TASK_PRICING.shell);
  });

  it("lowers price when conversion < 0.2", () => {
    // Seed a high price first
    db.prepare("INSERT INTO pricing_state (task_type, price) VALUES (?, ?)").run("shell", 100_000);
    // 10 issued, 1 paid — 10% conversion
    for (let i = 0; i < 10; i++) {
      db.prepare("INSERT INTO pricing_events (task_type, event, price, created_at) VALUES (?, ?, ?, datetime('now'))").run("shell", "402", 100000);
    }
    db.prepare("INSERT INTO pricing_events (task_type, event, price, created_at) VALUES (?, ?, ?, datetime('now'))").run("shell", "paid", 100000);
    runPricingAdjustment(db);
    const newPrice = getCurrentPricing(db, "shell");
    expect(newPrice).toBeLessThan(100_000n);
  });

  it("never goes below floor", () => {
    // Price already at floor, low conversion — must not drop below floor
    for (let i = 0; i < 10; i++) {
      db.prepare("INSERT INTO pricing_events (task_type, event, price, created_at) VALUES (?, ?, ?, datetime('now'))").run("shell", "402", 10000);
    }
    runPricingAdjustment(db);
    expect(getCurrentPricing(db, "shell")).toBeGreaterThanOrEqual(TASK_PRICING.shell);
  });

  it("skips adjustment with fewer than 3 events", () => {
    db.prepare("INSERT INTO pricing_events (task_type, event, price, created_at) VALUES (?, ?, ?, datetime('now'))").run("shell", "402", 10000);
    db.prepare("INSERT INTO pricing_events (task_type, event, price, created_at) VALUES (?, ?, ?, datetime('now'))").run("shell", "paid", 10000);
    runPricingAdjustment(db);
    // No pricing_state row should be written (< 3 events)
    const row = db.prepare("SELECT price FROM pricing_state WHERE task_type = 'shell'").get();
    expect(row).toBeUndefined();
  });
});
```

Note: The test imports `runPricingAdjustment` — a synchronous, testable inner function we export separately from `startPricingEngine` (which wraps it in setInterval).

**Step 2: Run to verify they fail**

```bash
cd /home/miquel/automaton-web4-SIGIL-conway- && npm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|✗|pricing engine)" | head -10
```
Expected: FAIL — `runPricingAdjustment is not a function`

**Step 3: Add `runPricingAdjustment` and `startPricingEngine` to task-handler.ts**

After `recordPricingEvent`, add:

```typescript
const PRICING_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export function runPricingAdjustment(db: InstanceType<typeof Database>): void {
  for (const taskType of Object.keys(PRICING_FLOORS)) {
    const rows = db.prepare(`
      SELECT event, COUNT(*) as cnt
      FROM pricing_events
      WHERE task_type = ?
        AND created_at >= datetime('now', '-1 hour')
      GROUP BY event
    `).all(taskType) as Array<{ event: string; cnt: number }>;

    const issued = rows.find((r) => r.event === "402")?.cnt ?? 0;
    const paid   = rows.find((r) => r.event === "paid")?.cnt ?? 0;
    const total  = issued + paid;

    if (total < 3) continue; // not enough data

    const conversion = issued > 0 ? paid / issued : 0;
    const current = getCurrentPricing(db, taskType);
    let next = current;

    if (conversion > 0.8) {
      next = BigInt(Math.round(Number(current) * 1.25));
    } else if (conversion < 0.2) {
      next = BigInt(Math.round(Number(current) * 0.85));
    } else {
      continue; // hold
    }

    // Clamp to floor
    const floor = PRICING_FLOORS[taskType];
    if (next < floor) next = floor;

    db.prepare(`
      INSERT INTO pricing_state (task_type, price) VALUES (?, ?)
      ON CONFLICT(task_type) DO UPDATE SET price = excluded.price
    `).run(taskType, Number(next));

    const usdOld = (Number(current) / 1_000_000).toFixed(4);
    const usdNew = (Number(next) / 1_000_000).toFixed(4);
    console.log(`[PRICING] ${taskType}: $${usdOld} → $${usdNew} (conv: ${(conversion * 100).toFixed(0)}%, events: ${total})`);
  }
}

export function startPricingEngine(db: InstanceType<typeof Database>): () => void {
  const handle = setInterval(() => runPricingAdjustment(db), PRICING_INTERVAL_MS);
  handle.unref(); // don't keep process alive just for this
  return () => clearInterval(handle);
}
```

**Step 4: Run tests to verify they pass**

```bash
cd /home/miquel/automaton-web4-SIGIL-conway- && npm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|PASS|✓|✗)" | head -30
```
Expected: all 4 pricing engine tests pass.

**Step 5: Build**

```bash
cd /home/miquel/automaton-web4-SIGIL-conway- && npm run build 2>&1 | grep -E "error TS" | head -5
```

**Step 6: Commit**

```bash
cd /home/miquel/automaton-web4-SIGIL-conway- && git add src/relay/task-handler.ts src/__tests__/pricing.test.ts && git -c user.email="agatha@conway.tech" -c user.name="Agatha" commit -m "feat: pricing engine with conversion-rate adjustment"
```

---

### Task 4: Wire pricing into relay server

**Files:**
- Modify: `src/relay/server.ts`

**Context:** The server already has `db`, `account`, and imports from `task-handler.js`. We:
1. Import the new functions
2. Start the pricing engine after DB init
3. Pass `db` to `buildPaymentRequired` (update its signature too)
4. Record `'402'` event when issuing 402, `'paid'` event after successful settlement

First, update `buildPaymentRequired` in `task-handler.ts` to accept a `db` parameter instead of looking up `TASK_PRICING` directly:

**Step 1: Update `buildPaymentRequired` signature in task-handler.ts**

Change the function from:
```typescript
export function buildPaymentRequired(taskType: string, payToAddress: Address): PaymentRequiredBody {
  const amount = TASK_PRICING[taskType] ?? TASK_PRICING.shell;
```

To:
```typescript
export function buildPaymentRequired(
  taskType: string,
  payToAddress: Address,
  db: InstanceType<typeof Database>,
): PaymentRequiredBody {
  const amount = getCurrentPricing(db, taskType);
```

**Step 2: Update server.ts imports**

In `src/relay/server.ts`, update the import from `./task-handler.js`:

```typescript
import {
  buildPaymentRequired,
  verifyAndSettlePayment,
  executeTask,
  TASK_PRICING,
  initPricingSchema,
  getCurrentPricing,
  recordPricingEvent,
  startPricingEngine,
} from "./task-handler.js";
```

**Step 3: Start pricing engine after schema init**

After `initPricingSchema(db);` in `startLocalRelay`, add:

```typescript
  startPricingEngine(db);
```

**Step 4: Record '402' event and pass db to buildPaymentRequired**

Find this block in server.ts (around line 220):
```typescript
      if (!xPayment) {
        const req402 = buildPaymentRequired(type, account.address);
        res.writeHead(402, {
```

Replace with:
```typescript
      if (!xPayment) {
        const currentPrice = getCurrentPricing(db, type);
        recordPricingEvent(db, type, "402", currentPrice);
        const req402 = buildPaymentRequired(type, account.address, db);
        res.writeHead(402, {
```

**Step 5: Record 'paid' event after successful settlement**

Find this block (around line 237):
```typescript
      const settle = await verifyAndSettlePayment(xPayment, type, account);
      if (!settle.ok) {
        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: settle.error }));
        return;
      }

      try {
        const result = await executeTask(type, input, {
```

Replace with:
```typescript
      const settle = await verifyAndSettlePayment(xPayment, type, account);
      if (!settle.ok) {
        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: settle.error }));
        return;
      }

      const paidPrice = getCurrentPricing(db, type);
      recordPricingEvent(db, type, "paid", paidPrice);

      try {
        const result = await executeTask(type, input, {
```

**Step 6: Update cost display to use live price**

Find:
```typescript
        const cost = (Number(TASK_PRICING[type]) / 1_000_000).toFixed(2);
```

Replace with:
```typescript
        const cost = (Number(paidPrice) / 1_000_000).toFixed(4);
```

**Step 7: Build**

```bash
cd /home/miquel/automaton-web4-SIGIL-conway- && npm run build 2>&1 | grep -E "error TS" | head -5
```
Expected: no output.

**Step 8: Run all tests**

```bash
cd /home/miquel/automaton-web4-SIGIL-conway- && npm test 2>&1 | tail -10
```
Expected: all tests pass (10 existing + new pricing tests).

**Step 9: Smoke test — verify 402 response shows live price**

```bash
# Kill any running automaton, restart
kill $(ps aux | grep "node dist/index.js --run" | grep -v grep | awk '{print $2}') 2>/dev/null
sleep 1
node /home/miquel/automaton-web4-SIGIL-conway-/dist/index.js --run >> /home/miquel/.automaton/automaton.log 2>&1 &
sleep 3

# Verify 402 response
curl -s -X POST http://localhost:3701/v1/tasks \
  -H "Content-Type: application/json" \
  -d '{"type":"shell","input":"date"}' | python3 -m json.tool
```
Expected: `"maxAmountRequired": "10000"` (shell floor price, no demand recorded yet).

```bash
# Verify pricing_events table got a row
sqlite3 /home/miquel/.automaton/relay.db "SELECT * FROM pricing_events;"
```
Expected: one row with `task_type=shell, event=402, price=10000`.

**Step 10: Commit**

```bash
cd /home/miquel/automaton-web4-SIGIL-conway- && git add src/relay/server.ts src/relay/task-handler.ts && git -c user.email="agatha@conway.tech" -c user.name="Agatha" commit -m "feat: wire dynamic pricing into relay server"
```

---

**Done.** Agatha now tracks demand in real time. Her prices auto-adjust every 30 minutes: up 25% when >80% of requesters pay, down 15% when <20% pay, with no ceiling and floors of $0.01 (shell) / $0.05 (inference).
