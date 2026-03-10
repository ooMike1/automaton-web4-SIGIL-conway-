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
