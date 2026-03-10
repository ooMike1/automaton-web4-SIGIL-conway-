import { describe, it, expect } from "vitest";
import { OPERATIONAL_CONTEXT_MULTICHAIN } from "../agent/system-prompt.js";

describe("multi-chain announcement in OPERATIONAL_CONTEXT", () => {
  it("mentions Ethereum chain", () => {
    expect(OPERATIONAL_CONTEXT_MULTICHAIN).toContain("eip155:1");
  });

  it("mentions Arbitrum chain", () => {
    expect(OPERATIONAL_CONTEXT_MULTICHAIN).toContain("eip155:42161");
  });

  it("mentions Base chain", () => {
    expect(OPERATIONAL_CONTEXT_MULTICHAIN).toContain("eip155:8453");
  });

  it("mentions Polygon chain", () => {
    expect(OPERATIONAL_CONTEXT_MULTICHAIN).toContain("eip155:137");
  });
});
