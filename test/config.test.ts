import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { fullEnv } from "./helpers.js";

const withoutStoreId = { ...fullEnv, BLOB_STORE_ID: undefined };

describe("loadConfig: Blob settings", () => {
  it("requires BLOB_READ_WRITE_TOKEN", () => {
    const { BLOB_READ_WRITE_TOKEN: _t, ...rest } = fullEnv;
    expect(() => loadConfig(rest)).toThrow("missing env: BLOB_READ_WRITE_TOKEN");
  });

  it("D8: BLOB_STORE_ID wins over the token, with store_ stripped and the id lowercased", () => {
    const config = loadConfig({ ...fullEnv, BLOB_STORE_ID: " store_EnvStore9 " });
    expect(config.blobStoreId).toBe("envstore9");
    expect(config.blobToken).toBe(fullEnv.BLOB_READ_WRITE_TOKEN);
    expect(loadConfig({ ...fullEnv, BLOB_STORE_ID: "plain-id" }).blobStoreId).toBe("plain-id");
  });

  it("D8: without BLOB_STORE_ID, the token's fourth segment, lowercased", () => {
    expect(loadConfig(withoutStoreId).blobStoreId).toBe("teststore01");
    expect(loadConfig({ ...fullEnv, BLOB_STORE_ID: "  " }).blobStoreId).toBe("teststore01");
  });

  it("D8: no usable id throws naming the variable, and never the value", () => {
    const fromToken = { ...withoutStoreId, BLOB_READ_WRITE_TOKEN: "opaque-fake-token-without-segments" };
    expect(() => loadConfig(fromToken)).toThrow("invalid env: BLOB_READ_WRITE_TOKEN");
    expect(() => loadConfig({ ...fromToken, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw__fake" })).toThrow(
      "invalid env: BLOB_READ_WRITE_TOKEN",
    );
    expect(() => loadConfig({ ...fullEnv, BLOB_STORE_ID: "store_" })).toThrow("invalid env: BLOB_STORE_ID");
  });

  it("D8: an id that is not a single DNS label is rejected", () => {
    const badIds = ["evil.example.test", "a/b", "a b", "a@b", "x".repeat(64), "café", "a:443", "a#b"];
    for (const id of badIds) {
      const error = (() => {
        try {
          loadConfig({ ...fullEnv, BLOB_STORE_ID: id });
        } catch (e) {
          return e;
        }
      })();
      expect(error, id).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toBe("invalid env: BLOB_STORE_ID");
    }
    const badToken = `vercel_blob_rw_evil.example.test_fake`;
    const error = (() => {
      try {
        loadConfig({ ...withoutStoreId, BLOB_READ_WRITE_TOKEN: badToken });
      } catch (e) {
        return e;
      }
    })();
    expect((error as Error).message).toBe("invalid env: BLOB_READ_WRITE_TOKEN");
    expect((error as Error).message).not.toContain("evil");
  });

  it("rejects hyphen edges and labels the URL parser cannot round-trip, without echoing the value", () => {
    for (const id of ["xn--abc", "-abc", "abc-", "-", "xn--a-b-c"]) {
      expect(() => loadConfig({ ...fullEnv, BLOB_STORE_ID: id }), id).toThrow(/^invalid env: BLOB_STORE_ID$/);
    }
    expect(() => loadConfig({ ...fullEnv, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_xn--abc_fake" })).toThrow(
      /^invalid env: BLOB_READ_WRITE_TOKEN$/,
    );
    expect(loadConfig({ ...fullEnv, BLOB_STORE_ID: "a-b-1" }).blobStoreId).toBe("a-b-1");
    expect(loadConfig({ ...fullEnv, BLOB_STORE_ID: "a".repeat(63) }).blobStoreId).toBe("a".repeat(63));
  });

  it("every configuration failure is a ConfigError", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ ...fullEnv, CRON_SECRET: "short" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...fullEnv, RETENTION_DAYS: "0" })).toThrow(ConfigError);
  });
});
