export interface Config {
  openrouterApiKey: string;
  connectorSecret: string;
  cronSecret: string;
  defaultModel: string;
  retentionDays: number;
  openrouterReferer: string;
}

const MIN_SECRET_LENGTH = 32;
const DEFAULT_MODEL = "openai/gpt-image-2.5-flare";
const DEFAULT_RETENTION_DAYS = 30;

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`missing env: ${name}`);
  return value;
}

// Secrets that gate the public endpoints fail closed: a deployment with a
// guessable secret must not start serving. Errors name the variable, never
// its value.
function strongSecret(env: Env, name: string): string {
  const value = required(env, name);
  if (value.length < MIN_SECRET_LENGTH) throw new Error(`weak secret: ${name}`);
  return value;
}

function retentionDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETENTION_DAYS;
  const trimmed = raw.trim();
  const days = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(days) || days < 1) {
    throw new Error("invalid env: RETENTION_DAYS");
  }
  return days;
}

export function loadConfig(env: Env): Config {
  return {
    openrouterApiKey: required(env, "OPENROUTER_API_KEY"),
    connectorSecret: strongSecret(env, "CONNECTOR_SECRET"),
    cronSecret: strongSecret(env, "CRON_SECRET"),
    defaultModel: env.DEFAULT_MODEL?.trim() || DEFAULT_MODEL,
    retentionDays: retentionDays(env.RETENTION_DAYS),
    openrouterReferer: env.OPENROUTER_REFERER?.trim() ?? "",
  };
}
