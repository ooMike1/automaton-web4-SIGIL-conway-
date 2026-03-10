import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initPricingSchema, buildPaymentRequired } from "../relay/task-handler.js";
import * as x402 from "../conway/x402.js";

describe("buildPaymentRequired multi-chain", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(":memory:");
    initPricingSchema(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns only Base when only Base has balance", async () => {
    vi.spyOn(x402, "getUsdcBalance").mockImplementation(async (_addr, network) => {
      return network === "eip155:8453" ? 1.0 : 0;
    });
    const result = await buildPaymentRequired("shell", "0xDEAD" as any, db);
    expect(result.accepts.length).toBe(1);
    expect(result.accepts[0].network).toBe("eip155:8453");
  });

  it("returns multiple chains when all have balance", async () => {
    vi.spyOn(x402, "getUsdcBalance").mockResolvedValue(2.0);
    const result = await buildPaymentRequired("shell", "0xDEAD" as any, db);
    expect(result.accepts.length).toBeGreaterThan(1);
    const networks = result.accepts.map((a) => a.network);
    expect(networks).toContain("eip155:8453");
    expect(networks).toContain("eip155:42161");
  });

  it("falls back to Base-only when all balances are 0", async () => {
    vi.spyOn(x402, "getUsdcBalance").mockResolvedValue(0);
    const result = await buildPaymentRequired("shell", "0xDEAD" as any, db);
    expect(result.accepts.length).toBe(1);
    expect(result.accepts[0].network).toBe("eip155:8453");
  });

  it("each accept entry has the correct USDC asset address for its chain", async () => {
    vi.spyOn(x402, "getUsdcBalance").mockImplementation(async (_addr, network) => {
      return network === "eip155:42161" ? 1.0 : 0;
    });
    const result = await buildPaymentRequired("shell", "0xDEAD" as any, db);
    const arb = result.accepts.find((a) => a.network === "eip155:42161");
    expect(arb?.asset).toBe(x402.USDC_ADDRESSES["eip155:42161"]);
  });
});
