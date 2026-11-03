import fs from 'node:fs';
import path from 'node:path';

export interface GatewayConfig {
  token: string;
  clientId: string;
  guildId: string;
  workerUrl: string;
  ingestToken: string;
  outboxPath: string;
  statePath: string;
  healthPort: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/** Minimal .env loader so `npm run dev` works without extra dependencies. */
function loadDotEnv(file = '.env'): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = String(env[key] || '').trim();
  if (!value) throw new Error(`Missing ${key}. Copy .env.example to .env and fill it in.`);
  return value;
}

function integer(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  loadDotEnv();
  const level = String(env.LOG_LEVEL || 'info').toLowerCase();
  return {
    token: required(env, 'DISCORD_TOKEN'),
    clientId: required(env, 'DISCORD_CLIENT_ID'),
    guildId: String(env.DISCORD_GUILD_ID || '').trim(),
    workerUrl: required(env, 'AURA_BOT_WORKER_URL').replace(/\/+$/, ''),
    ingestToken: required(env, 'AURA_BOT_INGEST_TOKEN'),
    outboxPath: path.resolve(String(env.OUTBOX_PATH || './data/outbox.json')),
    statePath: path.resolve(String(env.STATE_PATH || './data/state.json')),
    healthPort: integer(env.HEALTH_PORT, 9099),
    logLevel: (['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info') as GatewayConfig['logLevel'],
  };
}
