import { describe, expect, it } from "vitest";
import { isIpLiteral, isPublicIp } from "../src/net/ip.js";

describe("isPublicIp: blocked addresses", () => {
  const blocked = [
    // RFC 1918, loopback, link-local (cloud metadata), CGNAT, "this network"
    "10.0.0.1", "172.16.5.4", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    // multicast, reserved, limited broadcast, documentation, benchmarking
    "224.0.0.1", "240.0.0.1", "255.255.255.255", "192.0.2.1", "198.18.0.1",
    // IPv6: loopback, unspecified, link-local, ULA, multicast, IPv4-mapped loopback, NAT64, documentation
    "::1", "::", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2001:db8::1",
    // remaining reserved ranges and range edges
    "192.0.0.1", "192.88.99.1", "198.51.100.1", "203.0.113.1", "198.19.255.255", "100.127.255.255",
    "64:ff9b:1::1", "100::1", "fec0::1", "2001::1", "2002:7f00:1::", "3fff::1", "::127.0.0.1",
    // IPv4-mapped forms of private addresses, in hex and with mixed case
    "::ffff:7f00:1", "::FFFF:10.0.0.1", "0:0:0:0:0:ffff:a9fe:a9fe",
    // not parseable, so not public
    "fe80::1%eth0", "010.0.0.1", "1.2.3", "", "1.2.3.4.5", "256.1.1.1", "1.2.3.-4", " 1.1.1.1", "1.1.1.1 ",
    "0x7f.0.0.1", "2130706433", "::g", ":::", "1::2::3", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7::8", "[::1]",
    "2606:4700:4700::1111:", "12345::1", "::1.2.3", "1.2.3.4::",
  ];
  it.each(blocked)("%j", (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });
});

describe("isPublicIp: allowed addresses", () => {
  const allowed = [
    "93.184.216.34", "1.1.1.1", "2606:4700:4700::1111",
    "::ffff:1.1.1.1", "2001:4860:4860::8888", "100.128.0.1", "172.32.0.1",
    // neighbours of blocked ranges
    "172.15.255.255", "9.255.255.255", "11.0.0.1", "126.255.255.255", "128.0.0.1", "169.253.0.1", "169.255.0.1",
    "223.255.255.255", "192.0.1.1", "192.88.100.1", "198.17.255.255", "198.20.0.1", "2001:200::1", "2400::1",
    "2a00:1450:4001::200e", "3ffe::1", "3fff:1000::1",
  ];
  it.each(allowed)("%j", (ip) => {
    expect(isPublicIp(ip)).toBe(true);
  });

  it("accepts uppercase and uncompressed IPv6", () => {
    expect(isPublicIp("2606:4700:4700:0:0:0:0:1111")).toBe(true);
    expect(isPublicIp("2606:4700:4700::1111".toUpperCase())).toBe(true);
    expect(isPublicIp("::ffff:0101:0101")).toBe(true);
  });
});

describe("isIpLiteral", () => {
  it("detects literals after WHATWG normalization", () => {
    expect(isIpLiteral(new URL("http://0x7f.1/").hostname)).toBe(true);
    expect(isIpLiteral(new URL("http://2130706433/").hostname)).toBe(true);
    expect(isIpLiteral(new URL("http://[::1]/").hostname)).toBe(true);
    expect(isIpLiteral(new URL("http://[::ffff:7f00:1]/").hostname)).toBe(true);
    expect(isIpLiteral(new URL("http://1.1.1.1/").hostname)).toBe(true);
  });

  it("does not flag ordinary names", () => {
    expect(isIpLiteral("example.com")).toBe(false);
    expect(isIpLiteral("1password.example.com")).toBe(false);
    expect(isIpLiteral("cdn.example.co.uk")).toBe(false);
    expect(isIpLiteral("")).toBe(false);
  });

  it("flags names whose last label is numeric, which WHATWG would read as IPv4", () => {
    expect(isIpLiteral("1.2.3")).toBe(true);
    expect(isIpLiteral("example.0x10")).toBe(true);
    expect(isIpLiteral("12345")).toBe(true);
  });
});
