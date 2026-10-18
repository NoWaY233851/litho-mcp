// IP classification for the SSRF guard (ADR 0007). Addresses are parsed by hand rather than
// with node:net so the accepted syntax is exactly what is written here, and every input that
// does not parse is treated as not public (fail closed).
//
// Sources for the ranges:
//   IANA IPv4 Special-Purpose Address Registry, RFC 6890 and RFC 5735
//     https://www.iana.org/assignments/iana-ipv4-special-registry/
//   IANA IPv6 Special-Purpose Address Registry, RFC 6890 and RFC 8190
//     https://www.iana.org/assignments/iana-ipv6-special-registry/
//   RFC 4291 (IPv6 text forms), RFC 4380 (Teredo, inside 2001::/23), RFC 6052 (NAT64),
//   RFC 3849 (2001:db8::/32 documentation), RFC 9637 (3fff::/20 documentation).

/** Blocked IPv4 ranges as [base address, prefix length]. */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // carrier-grade NAT, RFC 6598
  ["127.0.0.0", 8], // loopback: the Lambda runtime API listens here
  ["169.254.0.0", 16], // link-local, including cloud metadata at 169.254.169.254
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // deprecated 6to4 relay anycast
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including 255.255.255.255
];

const parseV4 = (s: string): number[] | null => {
  // Strict dotted quad: leading zeros are refused because some resolvers read them as octal.
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(s);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
};

const v4ToInt = (o: number[]): number => ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;

const BLOCKED_V4_INT = BLOCKED_V4.map(([base, bits]) => {
  const start = v4ToInt(parseV4(base)!);
  const size = 2 ** (32 - bits);
  return [start, start + size - 1] as const;
});

const isPublicV4 = (octets: number[]): boolean => {
  const n = v4ToInt(octets);
  return !BLOCKED_V4_INT.some(([lo, hi]) => n >= lo && n <= hi);
};

/** Eight 16-bit groups of an RFC 4291 text address, or null. */
const parseV6 = (s: string): number[] | null => {
  if (s === "") return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (part: string, allowV4Tail: boolean): number[] | null => {
    if (part === "") return [];
    const items = part.split(":");
    const groups: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (allowV4Tail && i === items.length - 1 && item.includes(".")) {
        const v4 = parseV4(item);
        if (!v4) return null;
        groups.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9a-f]{1,4}$/i.test(item)) {
        groups.push(parseInt(item, 16));
      } else {
        return null;
      }
    }
    return groups;
  };

  if (halves.length === 1) {
    const groups = parseGroups(s, true);
    return groups && groups.length === 8 ? groups : null;
  }
  const head = parseGroups(halves[0]!, false);
  const tail = parseGroups(halves[1]!, true);
  // "::" stands for at least one group of zeros.
  if (!head || !tail || head.length + tail.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
};

const isPublicV6 = (g: number[]): boolean => {
  // IPv4-mapped (::ffff:0:0/96) is judged by the embedded IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return isPublicV4([g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff]);
  }
  // Only global unicast 2000::/3 can be public. This excludes ::, ::1, ::/96, NAT64
  // (64:ff9b::/96, 64:ff9b:1::/48), 100::/64, ULA, link-local, site-local and multicast.
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1]! < 0x0200) return false; // 2001::/23 protocol assignments, Teredo
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2002) return false; // 6to4 embeds arbitrary IPv4 addresses
  if (g[0] === 0x3fff && (g[1]! & 0xf000) === 0) return false; // documentation, 3fff::/20
  return true;
};

/** True only for a syntactically valid address outside every blocked range. */
export function isPublicIp(ip: string): boolean {
  const v4 = parseV4(ip);
  if (v4) return isPublicV4(v4);
  const v6 = parseV6(ip);
  return v6 ? isPublicV6(v6) : false;
}

/**
 * True when a URL hostname is an IP address in any notation. WHATWG URL parsing has already
 * normalized hex, octal and integer IPv4 forms to a dotted quad by the time a hostname is read
 * from a URL; the last-label rule below mirrors the URL spec's "ends in a number" check so a
 * hostname that was not normalized is refused rather than resolved.
 */
export function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith("[")) return true;
  if (parseV4(hostname) || parseV6(hostname)) return true;
  const last = hostname.replace(/\.+$/, "").split(".").pop()!;
  return /^(\d+|0x[0-9a-f]*)$/i.test(last);
}
