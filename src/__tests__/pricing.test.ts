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
