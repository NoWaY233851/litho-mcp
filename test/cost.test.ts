import { describe, expect, it } from "vitest";
import { formatCost } from "../src/openrouter/cost.js";

describe("formatCost", () => {
  it.each([
    [0.04, "$0.04"],
    [0.041, "$0.041"],
    [1, "$1.00"],
    [0.5, "$0.50"],
    [0, "$0.00"],
    [0.0000123, "$0.000012"],
    [0.000001, "$0.000001"],
    [12.3456789, "$12.345679"],
  ])("formats %s as %s", (usd, text) => {
    expect(formatCost(usd)).toBe(text);
  });

  it("never rounds a positive cost down to zero", () => {
    expect(formatCost(0.0000004)).toBe("<$0.000001");
  });
});
