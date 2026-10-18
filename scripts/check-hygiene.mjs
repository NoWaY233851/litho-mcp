// Scans files that are, or could become, part of the repository for personal
// information that must never be published. Every pattern is a regex so this
// file never matches its own rules.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SELF = "scripts/check-hygiene.mjs";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL = /@(users\.noreply\.github\.com|example\.com)$/i;
const PLACEHOLDER = /<your-subdomain>\.workers\.dev/g;
const PLACEHOLDER_PROJECT_HOST = /<project>\.vercel\.app/g;
// A concrete store host has a host-label character right before the suffix. The CSP wildcard,
// the <store-id> placeholder and code that builds the host from a variable (a quoted suffix
// constant, template interpolation) do not, so they document or derive the shape without
// naming a store.
const CONCRETE_BLOB_HOST = /[A-Za-z0-9-]\.public\.blob\.vercel-storage\.com/;

const rules = [
  { name: "home directory path", test: (l) => /\/Users\/[A-Za-z]|\/home\/[a-z]|C:\\Users\\[A-Za-z]/.test(l) },
  { name: "Cloudflare account id", test: (l) => /"account_id"\s*:/.test(l) },
  { name: "32-hex resource id", test: (l) => /"id"\s*:\s*"[0-9a-f]{32}"/.test(l) },
  { name: "workers.dev domain", test: (l) => /\.workers\.dev/.test(l.replace(PLACEHOLDER, "")) },
  { name: "Vercel project id", test: (l) => /"projectId"\s*:/.test(l) },
  { name: "Vercel org id", test: (l) => /"orgId"\s*:/.test(l) },
  { name: "vercel.app host", test: (l) => /\.vercel\.app/.test(l.replace(PLACEHOLDER_PROJECT_HOST, "")) },
  {
    name: "Blob store host",
    test: (l) => CONCRETE_BLOB_HOST.test(l),
  },
  {
    name: "email address",
    test: (l) => (l.match(EMAIL) ?? []).some((e) => !ALLOWED_EMAIL.test(e)),
  },
  { name: "local working docs reference", test: (l) => /superpowers/i.test(l) },
  // Tracked files cite ADRs in docs/design, not section numbers of other documents.
  { name: "spec section reference", test: (l) => /(^|[^a-z])spec ?[0-9§]/i.test(l) },
];

// Tracked files plus untracked files that are not ignored, so a run before
// `git add` is never a false clean. Local working docs are excluded through
// .git/info/exclude and therefore stay out of the list. Git runs from the
// repository root so the result does not depend on the caller's directory.
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const files = [
  ...new Set(
    execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter((f) => f && f !== SELF),
  ),
];

let hits = 0;
for (const file of files) {
  let buf;
  try {
    buf = readFileSync(join(root, file));
  } catch {
    continue; // listed but deleted in the working tree
  }
  if (buf.includes(0)) continue; // binary
  buf
    .toString("utf8")
    .split("\n")
    .forEach((line, i) => {
      for (const rule of rules) {
        if (rule.test(line)) {
          console.error(`${file}:${i + 1}: ${rule.name}`);
          hits++;
        }
      }
    });
}

if (hits > 0) {
  console.error(`hygiene: ${hits} problem(s) found`);
  process.exit(1);
}
console.log(`hygiene: ${files.length} files clean`);
