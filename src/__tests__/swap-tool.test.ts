import { describe, it, expect } from "vitest";
import { createBuiltinTools } from "../agent/tools.js";

const fakeCtx = {
  identity: { account: { address: "0x0000" }, address: "0x0000", apiKey: "" },
  config: { name: "test", conwayApiUrl: "", inferenceModel: "" } as any,
  conway: {} as any,
  db: {} as any,
  inference: {} as any,
};

describe("swap_tokens tool registration", () => {
  it("is registered in createBuiltinTools", () => {
    const tools = createBuiltinTools(fakeCtx as any);
    const t = tools.find((t) => t.name === "swap_tokens");
    expect(t).toBeDefined();
  });

  it("has category financial", () => {
    const tools = createBuiltinTools(fakeCtx as any);
    const t = tools.find((t) => t.name === "swap_tokens")!;
    expect(t.category).toBe("financial");
  });

  it("requires chain, fromToken, toToken, amountIn", () => {
    const tools = createBuiltinTools(fakeCtx as any);
    const t = tools.find((t) => t.name === "swap_tokens")!;
    expect(t.parameters.required).toEqual(
      expect.arrayContaining(["chain", "fromToken", "toToken", "amountIn"])
    );
  });
});
