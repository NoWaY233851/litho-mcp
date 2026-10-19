import { BLOB_HOST_SUFFIX, blobBaseUrl } from "./images/blob-url.js";

// Every configuration failure is a ConfigError. Its message names the offending
// variable and never a value, so it is the only kind of error the server logs
// verbatim while building its dependencies.
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// How the Blob SDK is authenticated (docs/design/0010-vercel-blob-storage.md).
// `token` is an explicit read-write token. `storeId` selects the OIDC path: the
// SDK takes the platform's OIDC token from the request context on each call, so
// no credential is held, resolved or validated here.
export type BlobAuth = { token: string } | { storeId: string };

export interface Config {
  openrouterApiKey: string;
  connectorSecret: string;
  cronSecret: string;
  defaultModel: string;
  retentionDays: number;
  openrouterReferer: string;
  blobAuth: BlobAuth;
  // Lowercase DNS label of the public Blob store host (docs/design/0010-vercel-blob-storage.md).
  blobStoreId: string;
}

const MIN_SECRET_LENGTH = 32;
const DEFAULT_MODEL = "openai/gpt-image-2.5-flare";
const DEFAULT_RETENTION_DAYS = 30;

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`missing env: ${name}`);
  return value;
}

// Secrets that gate the public endpoints fail closed: a deployment with a
// guessable secret must not start serving. Errors name the variable, never
// its value.
function strongSecret(env: Env, name: string): string {
  const value = required(env, name);
  if (value.length < MIN_SECRET_LENGTH) throw new ConfigError(`weak secret: ${name}`);
  return value;
}

function retentionDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETENTION_DAYS;
  const trimmed = raw.trim();
  const days = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(days) || days < 1) {
    throw new ConfigError("invalid env: RETENTION_DAYS");
  }
  return days;
}

// Letters and digits with inner hyphens only. Anything the URL parser would
// rewrite or reject (such as an "xn--" label with invalid punycode) fails the
// round-trip check below.
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function isStoreHost(id: string): boolean {
  try {
    return new URL(blobBaseUrl(id)).hostname === `${id}${BLOB_HOST_SUFFIX}`;
  } catch {
    return false;
  }
}

// The store id becomes part of every public URL, so it must be a single DNS
// label: anything else could change the host the server vouches for.
// BLOB_STORE_ID wins when set. Otherwise the id is the fourth `_`-separated
// segment of the read-write token (`vercel_blob_rw_<storeId>_...`), the same
// segment the Blob SDK reads. Without a token the id can only come from
// BLOB_STORE_ID (docs/design/0010-vercel-blob-storage.md). The SDK keeps the
// token's mixed case while the hosts it returns are lowercase.
function blobStoreId(env: Env, token: string | undefined): string {
  const explicit = env.BLOB_STORE_ID?.trim();
  const fromEnv = Boolean(explicit);
  const raw = fromEnv ? explicit!.replace(/^store_/, "") : ((token ?? "").split("_")[3] ?? "");
  const id = raw.toLowerCase();
  if (!DNS_LABEL.test(id) || !isStoreHost(id)) {
    throw new ConfigError(`invalid env: ${fromEnv ? "BLOB_STORE_ID" : "BLOB_READ_WRITE_TOKEN"}`);
  }
  return id;
}

// An explicit token always wins: the SDK would otherwise prefer OIDC whenever
// BLOB_STORE_ID is also set, silently changing which credential is used. With
// neither variable the config fails closed.
function blobAuth(env: Env): { auth: BlobAuth; token: string | undefined } {
  const token = env.BLOB_READ_WRITE_TOKEN?.trim() || undefined;
  if (token) return { auth: { token }, token };
  const storeId = env.BLOB_STORE_ID?.trim();
  if (storeId) return { auth: { storeId }, token: undefined };
  throw new ConfigError("missing env: BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID");
}

export function loadConfig(env: Env): Config {
  const openrouterApiKey = required(env, "OPENROUTER_API_KEY");
  const connectorSecret = strongSecret(env, "CONNECTOR_SECRET");
  const cronSecret = strongSecret(env, "CRON_SECRET");
  const blob = blobAuth(env);
  return {
    openrouterApiKey,
    connectorSecret,
    cronSecret,
    defaultModel: env.DEFAULT_MODEL?.trim() || DEFAULT_MODEL,
    retentionDays: retentionDays(env.RETENTION_DAYS),
    openrouterReferer: env.OPENROUTER_REFERER?.trim() ?? "",
    blobAuth: blob.auth,
    blobStoreId: blobStoreId(env, blob.token),
  };
}
