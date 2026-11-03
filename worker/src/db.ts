import type { BotSettings } from '../../src/shared/types';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../src/shared/settings';
import type { Env } from './env';
import { auditDetails } from './http';

export interface AuditInput {
  actorType: 'discord' | 'admin' | 'system';
  actorId?: string | null;
  actorName?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | number | null;
  details?: unknown;
}

export async function audit(env: Env, entry: AuditInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (actor_type, actor_id, actor_name, action, target_type, target_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      entry.actorType,
      entry.actorId ?? null,
      entry.actorName ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId == null ? null : String(entry.targetId),
      auditDetails(entry.details),
      Date.now(),
    )
    .run();
}

export async function loadSettings(env: Env): Promise<BotSettings> {
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const raw: Record<string, unknown> = {};
  for (const row of rows.results || []) {
    try {
      raw[row.key] = JSON.parse(row.value);
    } catch {
      raw[row.key] = row.value;
    }
  }
  return normalizeSettings(raw);
}

const SETTING_KEYS: Array<keyof BotSettings> = [
  'enabled',
  'maintenance',
  'maintenanceMessage',
  'threshold',
  'dispatchSize',
  'autoDispatch',
  'guildId',
  'channelIds',
  'logChannelId',
  'searchEnabled',
  'playlistExpand',
  'cooldownSeconds',
  'dailyLimit',
  'botName',
  'notifyOnDispatch',
  'notifyOnComplete',
  'notifyOnFailure',
];

export async function saveSettings(env: Env, patch: Partial<Record<keyof BotSettings, unknown>>): Promise<BotSettings> {
  const current = await loadSettings(env);
  const merged = normalizeSettings({ ...current, ...patch });
  const now = Date.now();
  const stmts = SETTING_KEYS.map((key) =>
    env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(key, JSON.stringify(merged[key]), now),
  );
  await env.DB.batch(stmts);
  return merged;
}

export async function settingValue(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSettingValue(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, Date.now())
    .run();
}

export async function queueCount(env: Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM submissions WHERE status = 'queued'`).first<{ c: number }>();
  return Number(row?.c || 0);
}

export async function activeBatch(env: Env): Promise<any | null> {
  return env.DB.prepare(
    `SELECT * FROM batches WHERE status IN ('dispatching','dispatched','running') ORDER BY id DESC LIMIT 1`,
  ).first<any>();
}

export async function upsertUser(
  env: Env,
  user: { id: string; username: string; displayName?: string; avatarUrl?: string },
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (discord_id, username, display_name, avatar_url, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(discord_id) DO UPDATE SET
       username = excluded.username,
       display_name = excluded.display_name,
       avatar_url = excluded.avatar_url,
       last_seen = excluded.last_seen`,
  )
    .bind(user.id, user.username.slice(0, 100), (user.displayName || user.username).slice(0, 100), user.avatarUrl || null, now, now)
    .run();
}

export async function bumpUser(env: Env, discordId: string, field: 'submissions' | 'accepted' | 'duplicates' | 'rejected' | 'downloaded', by = 1): Promise<void> {
  const allowed = new Set(['submissions', 'accepted', 'duplicates', 'rejected', 'downloaded']);
  if (!allowed.has(field)) return;
  await env.DB.prepare(`UPDATE users SET ${field} = ${field} + ?, last_seen = ? WHERE discord_id = ?`)
    .bind(by, Date.now(), discordId)
    .run();
}

export function defaultSettings(): BotSettings {
  return { ...DEFAULT_SETTINGS };
}
