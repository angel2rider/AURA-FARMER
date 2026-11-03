import type { Env } from './env';
import type {
  AdminAuditResponse,
  AdminBatchesResponse,
  AdminOverview,
  AdminQueueResponse,
  AdminUsersResponse,
  AuditEntry,
  BatchSummary,
  BotSettings,
  UserSummary,
} from '../../src/shared/types';
import { APP_VERSION } from '../../src/shared/types';
import { audit, loadSettings, queueCount, saveSettings } from './db';
import { dispatchQueued, reconcileBatches } from './dispatch';
import { error, json, num, readJson, str } from './http';

const BATCH_STATUSES = new Set(['dispatching', 'dispatched', 'running', 'completed', 'failed', 'retried']);
const SUB_STATUSES = new Set(['queued', 'batched', 'dispatched', 'downloaded', 'uploaded', 'failed', 'removed', 'rejected']);

function mapBatch(row: any): BatchSummary {
  return {
    id: Number(row.id),
    status: row.status,
    trackCount: Number(row.track_count || 0),
    runId: row.run_id ? Number(row.run_id) : null,
    runUrl: row.run_url || null,
    requestedBy: row.requested_by || 'auto',
    error: row.error || null,
    createdAt: Number(row.created_at || 0),
    dispatchedAt: row.dispatched_at ? Number(row.dispatched_at) : null,
    completedAt: row.completed_at ? Number(row.completed_at) : null,
    doneCount: Number(row.done_count || 0),
    failedCount: Number(row.failed_count || 0),
  };
}

function mapAudit(row: any): AuditEntry {
  let details: Record<string, unknown> | null = null;
  if (row.details) {
    try {
      const parsed = JSON.parse(row.details);
      details = parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      details = null;
    }
  }
  return {
    id: Number(row.id),
    actorType: row.actor_type,
    actorId: row.actor_id || null,
    actorName: row.actor_name || null,
    action: row.action,
    targetType: row.target_type || null,
    targetId: row.target_id || null,
    details,
    createdAt: Number(row.created_at || 0),
  };
}

function mapUser(row: any): UserSummary {
  return {
    discordId: row.discord_id,
    username: row.username,
    displayName: row.display_name || null,
    avatarUrl: row.avatar_url || null,
    firstSeen: Number(row.first_seen || 0),
    lastSeen: Number(row.last_seen || 0),
    banned: Boolean(row.banned),
    banReason: row.ban_reason || null,
    submissions: Number(row.submissions || 0),
    accepted: Number(row.accepted || 0),
    duplicates: Number(row.duplicates || 0),
    rejected: Number(row.rejected || 0),
    downloaded: Number(row.downloaded || 0),
  };
}

function startOfUtcDay(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

async function batchSummary(env: Env, id: number): Promise<BatchSummary | null> {
  const row = await env.DB.prepare(
    `SELECT b.*,
       (SELECT COUNT(*) FROM submissions s WHERE s.batch_id = b.id AND s.status IN ('downloaded','uploaded')) AS done_count,
       (SELECT COUNT(*) FROM submissions s WHERE s.batch_id = b.id AND s.status = 'failed') AS failed_count
     FROM batches b WHERE b.id = ?`,
  )
    .bind(id)
    .first<any>();
  return row ? mapBatch(row) : null;
}

async function getOverview(env: Env): Promise<AdminOverview> {
  const settings = await loadSettings(env);
  const status = await env.DB.prepare('SELECT * FROM bot_status WHERE id = 1').first<any>();
  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM submissions WHERE status = 'queued') AS queued,
       (SELECT COUNT(*) FROM batches WHERE status IN ('dispatching','dispatched','running')) AS active_batches,
       (SELECT COUNT(*) FROM submissions WHERE status = 'downloaded') AS downloaded,
       (SELECT COUNT(*) FROM submissions WHERE status = 'uploaded') AS uploaded,
       (SELECT COUNT(*) FROM submissions WHERE status = 'failed') AS failed,
       (SELECT COUNT(*) FROM submissions WHERE status = 'removed') AS removed,
       (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM submissions) AS submissions,
       (SELECT COUNT(*) FROM submissions WHERE created_at >= ?) AS today`,
  )
    .bind(startOfUtcDay())
    .first<any>();

  const activeRow = await env.DB.prepare(
    `SELECT b.*,
       (SELECT COUNT(*) FROM submissions s WHERE s.batch_id = b.id AND s.status IN ('downloaded','uploaded')) AS done_count,
       (SELECT COUNT(*) FROM submissions s WHERE s.batch_id = b.id AND s.status = 'failed') AS failed_count
     FROM batches b WHERE b.status IN ('dispatching','dispatched','running') ORDER BY b.id DESC LIMIT 1`,
  ).first<any>();

  const recentBatchRows = await env.DB.prepare(
    `SELECT b.*,
       (SELECT COUNT(*) FROM submissions s WHERE s.batch_id = b.id AND s.status IN ('downloaded','uploaded')) AS done_count,
       (SELECT COUNT(*) FROM submissions s WHERE s.batch_id = b.id AND s.status = 'failed') AS failed_count
     FROM batches b ORDER BY b.id DESC LIMIT 6`,
  ).all<any>();

  const auditRows = await env.DB.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 8').all<any>();
  const lastSeen = status?.last_seen ? Number(status.last_seen) : null;

  return {
    worker: { ok: true, now: Date.now(), version: APP_VERSION },
    bot: {
      online: Boolean(lastSeen && Date.now() - lastSeen < 90_000),
      lastSeen,
      version: status?.version || null,
      guildCount: status?.guild_count == null ? null : Number(status.guild_count),
      latencyMs: status?.latency_ms == null ? null : Number(status.latency_ms),
      botUser: status?.bot_user || null,
    },
    settings,
    counts: {
      queued: Number(counts?.queued || 0),
      activeBatches: Number(counts?.active_batches || 0),
      downloaded: Number(counts?.downloaded || 0),
      uploaded: Number(counts?.uploaded || 0),
      failed: Number(counts?.failed || 0),
      users: Number(counts?.users || 0),
      submissions: Number(counts?.submissions || 0),
      today: Number(counts?.today || 0),
      removed: Number(counts?.removed || 0),
    },
    activeBatch: activeRow ? mapBatch(activeRow) : null,
    recentBatches: (recentBatchRows.results || []).map(mapBatch),
    recentAudit: (auditRows.results || []).map(mapAudit),
  };
}

async function getQueue(env: Env, body: any): Promise<AdminQueueResponse> {
  const limit = Math.min(200, Math.max(1, num(body.limit, 50)));
  const offset = Math.max(0, num(body.offset, 0));
  const status = str(body.status, 30) || 'all';
  const q = str(body.q, 200);
  const where: string[] = [];
  const params: unknown[] = [];
  if (status !== 'all' && SUB_STATUSES.has(status)) {
    where.push('s.status = ?');
    params.push(status);
  }
  if (q) {
    where.push('(s.title LIKE ? OR s.artist LIKE ? OR s.video_id LIKE ? OR s.username LIKE ? OR s.url LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const order = status === 'queued' ? 'ASC' : 'DESC';
  const rows = await env.DB.prepare(
    `SELECT s.*, b.status AS batch_status
     FROM submissions s LEFT JOIN batches b ON b.id = s.batch_id
     ${clause} ORDER BY s.created_at ${order}, s.id ${order} LIMIT ? OFFSET ?`,
  )
    .bind(...params, limit, offset)
    .all<any>();
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM submissions s ${clause}`)
    .bind(...params)
    .first<{ c: number }>();
  return {
    items: (rows.results || []).map((row) => ({
      id: Number(row.id),
      url: row.url,
      videoId: row.video_id,
      title: row.title || null,
      artist: row.artist || null,
      username: row.username,
      discordId: row.discord_id,
      status: row.status,
      createdAt: Number(row.created_at || 0),
      batchId: row.batch_id ? Number(row.batch_id) : null,
      batchStatus: row.batch_status || null,
      error: row.error || null,
      channelId: row.channel_id,
      source: row.source,
    })),
    total: Number(totalRow?.c || 0),
    limit,
    offset,
  };
}

async function getBatches(env: Env, body: any): Promise<AdminBatchesResponse> {
  const limit = Math.min(100, Math.max(1, num(body.limit, 25)));
  const offset = Math.max(0, num(body.offset, 0));
  const status = str(body.status, 30);
  const where: string[] = [];
  const params: unknown[] = [];
  if (status && BATCH_STATUSES.has(status)) {
    where.push('b.status = ?');
    params.push(status);
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await env.DB.prepare(
    `SELECT b.*,
       (SELECT COUNT(*) FROM submissions s WHERE s.batch_id = b.id AND s.status IN ('downloaded','uploaded')) AS done_count,
       (SELECT COUNT(*) FROM submissions s WHERE s.batch_id = b.id AND s.status = 'failed') AS failed_count
     FROM batches b ${clause} ORDER BY b.id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, limit, offset)
    .all<any>();
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM batches b ${clause}`)
    .bind(...params)
    .first<{ c: number }>();
  return { items: (rows.results || []).map(mapBatch), total: Number(totalRow?.c || 0) };
}

async function getUsers(env: Env, body: any): Promise<AdminUsersResponse> {
  const limit = Math.min(200, Math.max(1, num(body.limit, 50)));
  const offset = Math.max(0, num(body.offset, 0));
  const q = str(body.q, 100);
  const where: string[] = [];
  const params: unknown[] = [];
  if (q) {
    where.push('(username LIKE ? OR display_name LIKE ? OR discord_id LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await env.DB.prepare(
    `SELECT * FROM users ${clause} ORDER BY last_seen DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, limit, offset)
    .all<any>();
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM users ${clause}`)
    .bind(...params)
    .first<{ c: number }>();
  return { items: (rows.results || []).map(mapUser), total: Number(totalRow?.c || 0) };
}

async function getAudit(env: Env, body: any): Promise<AdminAuditResponse> {
  const limit = Math.min(200, Math.max(1, num(body.limit, 50)));
  const offset = Math.max(0, num(body.offset, 0));
  const actionFilter = str(body.actionFilter, 80);
  const actor = str(body.actor, 100);
  const where: string[] = [];
  const params: unknown[] = [];
  if (actionFilter && actionFilter !== 'all') {
    where.push('action LIKE ?');
    params.push(actionFilter + '%');
  }
  if (actor) {
    where.push('(actor_id = ? OR actor_name LIKE ?)');
    params.push(actor, `%${actor}%`);
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await env.DB.prepare(
    `SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, limit, offset)
    .all<any>();
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM audit_log ${clause}`)
    .bind(...params)
    .first<{ c: number }>();
  return { items: (rows.results || []).map(mapAudit), total: Number(totalRow?.c || 0) };
}

async function updateSettings(env: Env, body: any, adminEmail: string): Promise<Response> {
  if (!body.settings || typeof body.settings !== 'object') return error('missing settings', 400);
  const before = await loadSettings(env);
  const after = await saveSettings(env, body.settings as Partial<Record<keyof BotSettings, unknown>>);
  const changed: Array<keyof BotSettings> = [];
  for (const key of Object.keys(after) as Array<keyof BotSettings>) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed.push(key);
  }
  if (changed.length) {
    await audit(env, {
      actorType: 'admin',
      actorId: adminEmail,
      actorName: adminEmail,
      action: 'admin.settings_changed',
      targetType: 'settings',
      targetId: 'bot',
      details: {
        changed,
        before: Object.fromEntries(changed.map((k) => [k, before[k]])),
        after: Object.fromEntries(changed.map((k) => [k, after[k]])),
      },
    });
  }
  return json({ ok: true, settings: after, changed });
}

async function removeQueue(env: Env, body: any, adminEmail: string): Promise<Response> {
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n: number) => Number.isFinite(n) && n > 0).slice(0, 200) : [];
  if (!ids.length) return error('no submission ids', 400);
  const placeholders = ids.map(() => '?').join(',');
  const result = await env.DB.prepare(
    `UPDATE submissions SET status = 'removed', error = ?, updated_at = ?
     WHERE id IN (${placeholders}) AND status IN ('queued','failed')`,
  )
    .bind('removed by admin', Date.now(), ...ids)
    .run();
  const removed = Number(result.meta?.changes || 0);
  if (removed) {
    await audit(env, {
      actorType: 'admin',
      actorId: adminEmail,
      actorName: adminEmail,
      action: 'admin.queue_removed',
      targetType: 'submission',
      targetId: null,
      details: { ids, removed },
    });
  }
  return json({ ok: true, removed, queueCount: await queueCount(env) });
}

async function retryQueue(env: Env, body: any, adminEmail: string): Promise<Response> {
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n: number) => Number.isFinite(n) && n > 0).slice(0, 200) : [];
  if (!ids.length) return error('no submission ids', 400);
  const placeholders = ids.map(() => '?').join(',');
  const result = await env.DB.prepare(
    `UPDATE submissions SET status = 'queued', batch_id = NULL, error = NULL, updated_at = ?
     WHERE id IN (${placeholders}) AND status = 'failed'`,
  )
    .bind(Date.now(), ...ids)
    .run();
  const retried = Number(result.meta?.changes || 0);
  if (retried) {
    await audit(env, {
      actorType: 'admin',
      actorId: adminEmail,
      actorName: adminEmail,
      action: 'admin.queue_retried',
      targetType: 'submission',
      targetId: null,
      details: { ids, retried },
    });
  }
  return json({ ok: true, retried, queueCount: await queueCount(env) });
}

async function retryBatch(env: Env, body: any, adminEmail: string): Promise<Response> {
  const id = num(body.id, 0);
  if (!id) return error('missing batch id', 400);
  const batch = await env.DB.prepare('SELECT * FROM batches WHERE id = ?').bind(id).first<any>();
  if (!batch) return error('batch not found', 404);
  if (['dispatching', 'dispatched', 'running'].includes(batch.status)) {
    return error('batch is still active', 409);
  }
  const result = await env.DB.prepare(
    `UPDATE submissions SET status = 'queued', batch_id = NULL, error = NULL, updated_at = ?
     WHERE batch_id = ? AND status = 'failed'`,
  )
    .bind(Date.now(), id)
    .run();
  const retried = Number(result.meta?.changes || 0);
  await env.DB.prepare(`UPDATE batches SET status = 'retried', error = NULL WHERE id = ?`).bind(id).run();
  await audit(env, {
    actorType: 'admin',
    actorId: adminEmail,
    actorName: adminEmail,
    action: 'admin.batch_retried',
    targetType: 'batch',
    targetId: id,
    details: { batchId: id, retried },
  });
  return json({ ok: true, retried, queueCount: await queueCount(env) });
}

async function banUser(env: Env, body: any, adminEmail: string): Promise<Response> {
  const discordId = str(body.discordId, 32);
  if (!discordId) return error('missing Discord id', 400);
  const user = await env.DB.prepare('SELECT * FROM users WHERE discord_id = ?').bind(discordId).first<any>();
  if (!user) return error('user not found', 404);
  const banned = body.banned === true || body.banned === 1 || body.banned === 'true';
  const reason = str(body.reason, 300) || null;
  await env.DB.prepare('UPDATE users SET banned = ?, ban_reason = ? WHERE discord_id = ?')
    .bind(banned ? 1 : 0, banned ? reason : null, discordId)
    .run();
  let removed = 0;
  if (banned && body.removeQueued !== false) {
    const result = await env.DB.prepare(
      `UPDATE submissions SET status = 'removed', error = ?, updated_at = ? WHERE discord_id = ? AND status = 'queued'`,
    )
      .bind('submitter banned', Date.now(), discordId)
      .run();
    removed = Number(result.meta?.changes || 0);
  }
  await audit(env, {
    actorType: 'admin',
    actorId: adminEmail,
    actorName: adminEmail,
    action: banned ? 'admin.user_banned' : 'admin.user_unbanned',
    targetType: 'user',
    targetId: discordId,
    details: { username: user.username, reason, removedQueued: removed },
  });
  const updated = await env.DB.prepare('SELECT * FROM users WHERE discord_id = ?').bind(discordId).first<any>();
  return json({ ok: true, user: updated ? mapUser(updated) : null, removed });
}

async function dispatchNow(env: Env, body: any, adminEmail: string): Promise<Response> {
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n: number) => Number.isFinite(n) && n > 0).slice(0, 25) : undefined;
  const result = await dispatchQueued(env, {
    requestedBy: adminEmail,
    ids: ids && ids.length ? ids : undefined,
    force: true,
    mode: 'admin',
  });
  if (!result.ok && result.waiting) {
    return json({ ...result, error: result.reason || 'dispatch is busy' }, 409);
  }
  if (!result.ok) return json({ ...result, error: result.error || 'dispatch failed' }, 502);
  return json(result);
}

export async function handleAdmin(env: Env, request: Request, adminEmail: string): Promise<Response> {
  let body: any;
  try {
    body = await readJson(request);
  } catch (e) {
    return error((e as Error).message || 'invalid JSON', 400);
  }
  const action = str(body.action, 50);
  if (!action) return error('missing action', 400);

  switch (action) {
    case 'overview':
      return json(await getOverview(env));
    case 'queue':
      return json(await getQueue(env, body));
    case 'batches':
      return json(await getBatches(env, body));
    case 'users':
      return json(await getUsers(env, body));
    case 'audit':
      return json(await getAudit(env, body));
    case 'settings':
      return json({ settings: await loadSettings(env) });
    case 'settingsUpdate':
      return updateSettings(env, body, adminEmail);
    case 'queueRemove':
      return removeQueue(env, body, adminEmail);
    case 'queueRetry':
      return retryQueue(env, body, adminEmail);
    case 'batchRetry':
      return retryBatch(env, body, adminEmail);
    case 'userBan':
      return banUser(env, body, adminEmail);
    case 'dispatch':
      return dispatchNow(env, body, adminEmail);
    case 'reconcile': {
      const result = await reconcileBatches(env);
      await audit(env, {
        actorType: 'admin',
        actorId: adminEmail,
        actorName: adminEmail,
        action: 'admin.reconcile',
        targetType: 'system',
        targetId: 'batches',
        details: result,
      });
      return json({ ok: true, ...result });
    }
    case 'batch': {
      const id = num(body.id, 0);
      if (!id) return error('missing batch id', 400);
      const batch = await batchSummary(env, id);
      if (!batch) return error('batch not found', 404);
      return json({ batch });
    }
    default:
      return error('unknown action', 400);
  }
}
