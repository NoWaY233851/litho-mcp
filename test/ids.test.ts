import { describe, expect, it } from "vitest";
import { newImageId, parseImageId } from "../src/images/ids.js";

describe("image ids", () => {
  it("newImageId yields <kind>_<32 lowercase hex> and does not repeat", () => {
    const a = newImageId("img");
    const b = newImageId("up");
    expect(a).toMatch(/^img_[0-9a-f]{32}$/);
    expect(b).toMatch(/^up_[0-9a-f]{32}$/);
    expect(newImageId("img")).not.toBe(a);
  });

  it("parseImageId returns kind and hex for a valid id", () => {
    const hex = "0123456789abcdef0123456789abcdef";
    expect(parseImageId(`img_${hex}`)).toEqual({ kind: "img", hex });
    expect(parseImageId(`up_${hex}`)).toEqual({ kind: "up", hex });
  });

  it("parseImageId rejects a wrong kind, length, case or trailing text", () => {
    const hex = "0123456789abcdef0123456789abcdef";
    for (const bad of [
      "",
      `vid_${hex}`,
      `IMG_${hex}`,
      `img_${hex.toUpperCase()}`,
      `img_${hex.slice(1)}`,
      `img_${hex}0`,
      `img_${hex}\n`,
      `img_${"g".repeat(32)}`,
      ` img_${hex}`,
      hex,
    ]) {
      expect(parseImageId(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
