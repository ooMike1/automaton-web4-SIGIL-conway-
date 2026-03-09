import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initPricingSchema, getCurrentPricing, recordPricingEvent, TASK_PRICING } from "../relay/task-handler.js";

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
