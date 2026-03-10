import { describe, it, expect, vi, afterEach } from "vitest";
import { swapTokens } from "../utilities/swap.js";

describe("swapTokens validation", () => {
  it("throws for unsupported chain", async () => {
    const account = { address: "0xABCD" } as any;
    await expect(swapTokens(account, "eip155:999", "native", "0xUSDP", 0.01))
      .rejects.toThrow("Unsupported chain: eip155:999");
  });
});

describe("swapTokens Li.Fi error handling", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("throws when Li.Fi quote returns non-OK", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      text: async () => "service unavailable",
    }));
    const account = { address: "0xABCD" } as any;
    await expect(swapTokens(account, "eip155:8453", "native", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 0.001))
      .rejects.toThrow("Li.Fi quote failed: service unavailable");
  });

  it("throws when no transactionRequest in quote", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "quote-abc" }), // missing transactionRequest
    }));
    const account = { address: "0xABCD" } as any;
    await expect(swapTokens(account, "eip155:8453", "native", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 0.001))
      .rejects.toThrow("No transactionRequest in Li.Fi swap quote");
  });
});
