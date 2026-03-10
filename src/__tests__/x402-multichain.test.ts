import { describe, it, expect } from "vitest";
import { CHAINS, USDC_ADDRESSES, RPC_URLS } from "../conway/x402.js";

describe("x402 exported chain constants", () => {
  it("exports CHAINS with Base and Arbitrum", () => {
    expect(CHAINS["eip155:8453"]).toBeDefined();
    expect(CHAINS["eip155:42161"]).toBeDefined();
  });

  it("exports USDC_ADDRESSES for all four mainnet chains", () => {
    expect(USDC_ADDRESSES["eip155:8453"]).toMatch(/^0x/);
    expect(USDC_ADDRESSES["eip155:42161"]).toMatch(/^0x/);
    expect(USDC_ADDRESSES["eip155:1"]).toMatch(/^0x/);
    expect(USDC_ADDRESSES["eip155:137"]).toMatch(/^0x/);
  });

  it("exports RPC_URLS for all four mainnet chains", () => {
    expect(RPC_URLS["eip155:8453"]).toContain("base");
    expect(RPC_URLS["eip155:42161"]).toContain("arb");
    expect(RPC_URLS["eip155:1"]).toBeDefined();
    expect(RPC_URLS["eip155:137"]).toBeDefined();
  });

  it("CHAINS entries have correct numeric chainId via .id", () => {
    expect(CHAINS["eip155:8453"].id).toBe(8453);
    expect(CHAINS["eip155:42161"].id).toBe(42161);
    expect(CHAINS["eip155:1"].id).toBe(1);
    expect(CHAINS["eip155:137"].id).toBe(137);
  });
});
