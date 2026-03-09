import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initPricingSchema, getCurrentPricing, recordPricingEvent, TASK_PRICING, runPricingAdjustment, startPricingEngine } from "../relay/task-handler.js";

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
    runPricingAdjustment(db);
    const newPrice = getCurrentPricing(db, "shell");
    expect(newPrice).toBeGreaterThan(TASK_PRICING.shell);
  });

  it("lowers price when conversion < 0.2", () => {
    db.prepare("INSERT INTO pricing_state (task_type, price) VALUES (?, ?)").run("shell", 100_000);
    for (let i = 0; i < 10; i++) {
      db.prepare("INSERT INTO pricing_events (task_type, event, price, created_at) VALUES (?, ?, ?, datetime('now'))").run("shell", "402", 100000);
    }
    db.prepare("INSERT INTO pricing_events (task_type, event, price, created_at) VALUES (?, ?, ?, datetime('now'))").run("shell", "paid", 100000);
    runPricingAdjustment(db);
    const newPrice = getCurrentPricing(db, "shell");
    expect(newPrice).toBeLessThan(100_000n);
  });

  it("never goes below floor", () => {
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
    const row = db.prepare("SELECT price FROM pricing_state WHERE task_type = 'shell'").get();
    expect(row).toBeUndefined();
  });
});
