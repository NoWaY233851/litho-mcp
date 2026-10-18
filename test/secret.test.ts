import { describe, expect, it } from "vitest";
import { extractSecret, secretMatches } from "../src/auth/secret.js";

describe("extractSecret", () => {
  it("strips a case-insensitive Bearer prefix and surrounding whitespace", () => {
    for (const header of ["Bearer s", "bearer s", "BEARER s", "s", "  Bearer s\n", " s "]) {
      expect(extractSecret(header)).toBe("s");
    }
  });

  it("returns null for a missing, empty or prefix-only header", () => {
    for (const header of [null, "", "   ", "Bearer ", "Bearer    ", "bearer"]) {
      expect(extractSecret(header)).toBeNull();
    }
  });

  it("does not treat a secret that merely starts with the letters as a prefix", () => {
    expect(extractSecret("Bearerish")).toBe("Bearerish");
  });
});

describe("secretMatches", () => {
  const expected = "test-connector-secret-0123456789abcdef";

  it("accepts an equal secret, ignoring whitespace around the expected value", () => {
    expect(secretMatches(expected, expected)).toBe(true);
    expect(secretMatches(expected, `  ${expected}\n`)).toBe(true);
  });

  it("rejects a different length, different content, an empty value or null", () => {
    expect(secretMatches(`${expected}x`, expected)).toBe(false);
    expect(secretMatches(expected.slice(1), expected)).toBe(false);
    expect(secretMatches(expected.replace("a", "b"), expected)).toBe(false);
    expect(secretMatches("", expected)).toBe(false);
    expect(secretMatches(null, expected)).toBe(false);
  });

  it("never matches anything against an empty expected secret", () => {
    expect(secretMatches("", "")).toBe(false);
    expect(secretMatches(null, "")).toBe(false);
  });
});
