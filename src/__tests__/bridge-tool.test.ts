import { describe, it, expect } from "vitest";
import { createBuiltinTools } from "../agent/tools.js";

describe("bridge_usdc tool registration", () => {
  it("is registered in createBuiltinTools", () => {
    const tools = createBuiltinTools("test-sandbox");
    const tool = tools.find((t) => t.name === "bridge_usdc");
    expect(tool).toBeDefined();
  });

  it("has category 'financial'", () => {
    const tools = createBuiltinTools("test-sandbox");
    const tool = tools.find((t) => t.name === "bridge_usdc")!;
    expect(tool.category).toBe("financial");
  });

  it("requires fromChain, toChain, amountUsdc params", () => {
    const tools = createBuiltinTools("test-sandbox");
    const tool = tools.find((t) => t.name === "bridge_usdc")!;
    const required = (tool.parameters as any).required as string[];
    expect(required).toContain("fromChain");
    expect(required).toContain("toChain");
    expect(required).toContain("amountUsdc");
  });
});
