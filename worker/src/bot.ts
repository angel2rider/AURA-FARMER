import type { Env } from './env';
import type {
  BotConfig,
  SearchResult,
  SubmitItemResult,
  SubmitPayload,
  SubmitResponse,
} from '../../src/shared/types';
import { channelList, settingsToConfig } from '../../src/shared/settings';
import { canonicalVideoUrl, isPlaylistUrl, playlistIdFromUrl, videoIdFromUrl } from '../../src/shared/urls';
import { auraExpand, auraSearch, auraLibraryVideoIds } from './aura';
import { audit, bumpUser, loadSettings, queueCount, upsertUser } from './db';
import { dispatchQueued } from './dispatch';
import { error, json, readJson, str } from './http';
import { hydrateItems } from './youtube';

const ACTIVE_STATUSES = `('queued','batched','dispatched','downloaded','uploaded')`;

function startOfUtcDay(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export async function handleSubmit(env: Env, request: Request, ctx: ExecutionContext): Promise<Response> {
  let body: SubmitPayload;
  try {
    body = await readJson<SubmitPayload>(request);
  } catch (e) {
    return error((e as Error).message || 'invalid JSON', 400);
  }

  const user = body?.user;
  const items = Array.isArray(body?.items) ? body.items.slice(0, 100) : [];
  if (!user || !str(user.id, 32) || !str(user.username, 100)) return error('missing Discord user', 400);
  if (!str(body.channelId, 32)) return error('missing channel id', 400);
  if (!items.length) return error('no links given', 400);

  const settings = await loadSettings(env);
  const allowed = channelList(settings.channelIds);
  if (allowed.length && !allowed.includes(String(body.channelId))) {
    return error('this channel is not configured for Aura Farmer', 403);
  }

  if (!settings.enabled) {
    return json({
      ok: false,
      results: items.map((i) => ({ url: str(i.url), videoId: str(i.videoId, 16), status: 'disabled', detail: 'Aura Farmer is disabled' })),
      queueCount: await queueCount(env),
      threshold: settings.threshold,
      message: 'Aura Farmer is disabled.',
    } satisfies SubmitResponse);
  }
  if (settings.maintenance) {
    return json({
      ok: false,
      results: items.map((i) => ({ url: str(i.url), videoId: str(i.videoId, 16), status: 'disabled', detail: settings.maintenanceMessage })),
      queueCount: await queueCount(env),
      threshold: settings.threshold,
      message: settings.maintenanceMessage,
    } satisfies SubmitResponse);
  }

  await upsertUser(env, {
    id: String(user.id),
    username: String(user.username),
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  });

  const dbUser = await env.DB.prepare('SELECT banned, ban_reason FROM users WHERE discord_id = ?')
    .bind(String(user.id))
    .first<{ banned: number; ban_reason: string | null }>();
  if (dbUser?.banned) {
    await audit(env, {
      actorType: 'discord',
      actorId: String(user.id),
      actorName: String(user.username),
      action: 'submission.banned',
      targetType: 'user',
      targetId: String(user.id),
      details: { reason: dbUser.ban_reason },
    });
    return json({
      ok: false,
      results: items.map((i) => ({ url: str(i.url), videoId: str(i.videoId, 16), status: 'banned', detail: dbUser.ban_reason || 'banned' })),
      queueCount: await queueCount(env),
      threshold: settings.threshold,
      message: dbUser.ban_reason || 'You are banned from submitting links.',
    } satisfies SubmitResponse);
  }

  if (settings.cooldownSeconds > 0) {
    const last = await env.DB.prepare(
      `SELECT created_at FROM submissions WHERE discord_id = ? ORDER BY id DESC LIMIT 1`,
    )
      .bind(String(user.id))
      .first<{ created_at: number }>();
    if (last && Date.now() - last.created_at < settings.cooldownSeconds * 1000) {
      const wait = Math.ceil((settings.cooldownSeconds * 1000 - (Date.now() - last.created_at)) / 1000);
      return json({
        ok: false,
        results: items.map((i) => ({ url: str(i.url), videoId: str(i.videoId, 16), status: 'cooldown', detail: `wait ${wait}s` })),
        queueCount: await queueCount(env),
        threshold: settings.threshold,
        message: `Cooldown: wait ${wait}s before submitting again.`,
      } satisfies SubmitResponse);
    }
  }

  if (settings.dailyLimit > 0) {
    const today = await env.DB.prepare('SELECT COUNT(*) AS c FROM submissions WHERE discord_id = ? AND created_at >= ?')
      .bind(String(user.id), startOfUtcDay())
      .first<{ c: number }>();
    if (Number(today?.c || 0) >= settings.dailyLimit) {
      return json({
        ok: false,
        results: items.map((i) => ({ url: str(i.url), videoId: str(i.videoId, 16), status: 'limit', detail: 'daily limit reached' })),
        queueCount: await queueCount(env),
        threshold: settings.threshold,
        message: `Daily limit reached (${settings.dailyLimit}).`,
      } satisfies SubmitResponse);
    }
  }

  const normalized = items
    .map((item) => {
      const url = str(item.url, 500);
      const videoId = str(item.videoId, 32) || videoIdFromUrl(url) || '';
      return {
        ...item,
        url: videoId ? canonicalVideoUrl(videoId) : url,
        videoId,
        title: str(item.title, 200) || undefined,
        artist: str(item.artist, 200) || undefined,
        album: str(item.album, 200) || undefined,
        source: item.source || 'message',
        clientKey: str(item.clientKey, 200) || `${body.messageId || 'api'}:${videoId || url}`,
      };
    })
    .filter((item) => item.videoId && /^[A-Za-z0-9_-]{11}$/.test(item.videoId));

  if (!normalized.length) return error('no valid YouTube links', 400);
  await hydrateItems(normalized);

  const libraryVideoIds = await auraLibraryVideoIds(env);

  const results: SubmitItemResult[] = [];
  let queued = 0;
  let duplicates = 0;
  let rejected = 0;

  for (const item of normalized) {
    if (libraryVideoIds.has(item.videoId)) {
      duplicates++;
      await bumpUser(env, String(user.id), 'duplicates');
      await audit(env, {
        actorType: 'discord',
        actorId: String(user.id),
        actorName: String(user.username),
        action: 'submission.duplicate',
        targetType: 'video',
        targetId: item.videoId,
        details: { url: item.url, title: item.title || null, channelId: body.channelId, reason: 'already in library' },
      });
      results.push({ url: item.url, videoId: item.videoId, status: 'duplicate', title: item.title, detail: 'already in Aura library' });
      continue;
    }

    const existing = await env.DB.prepare(
      `SELECT 1 FROM submissions WHERE video_id = ? AND status IN ${ACTIVE_STATUSES} LIMIT 1`,
    )
      .bind(item.videoId)
      .first();
    const keyHit = await env.DB.prepare('SELECT 1 FROM submissions WHERE source_key = ? LIMIT 1')
      .bind(item.clientKey)
      .first();
    if (existing || keyHit) {
      duplicates++;
      await bumpUser(env, String(user.id), 'duplicates');
      await audit(env, {
        actorType: 'discord',
        actorId: String(user.id),
        actorName: String(user.username),
        action: 'submission.duplicate',
        targetType: 'video',
        targetId: item.videoId,
        details: { url: item.url, title: item.title || null, channelId: body.channelId },
      });
      results.push({ url: item.url, videoId: item.videoId, status: 'duplicate', title: item.title, detail: 'already queued or in the library' });
      continue;
    }

    try {
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO submissions
          (guild_id, channel_id, message_id, source_key, discord_id, username, url, video_id, title, artist, album, source, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
        .bind(
          body.guildId ? String(body.guildId) : null,
          String(body.channelId),
          body.messageId ? String(body.messageId) : null,
          item.clientKey,
          String(user.id),
          String(user.username).slice(0, 100),
          item.url,
          item.videoId,
          item.title || null,
          item.artist || null,
          item.album || null,
          item.source,
          now,
          now,
        )
        .run();
      queued++;
      await bumpUser(env, String(user.id), 'submissions');
      await bumpUser(env, String(user.id), 'accepted');
      await audit(env, {
        actorType: 'discord',
        actorId: String(user.id),
        actorName: String(user.username),
        action: 'submission.queued',
        targetType: 'video',
        targetId: item.videoId,
        details: {
          url: item.url,
          title: item.title || null,
          artist: item.artist || null,
          channelId: body.channelId,
          messageId: body.messageId || null,
          source: item.source,
        },
      });
      results.push({ url: item.url, videoId: item.videoId, status: 'queued', title: item.title });
    } catch (e) {
      if (/UNIQUE/i.test((e as Error).message || '')) {
        duplicates++;
        results.push({ url: item.url, videoId: item.videoId, status: 'duplicate', title: item.title });
      } else {
        rejected++;
        await audit(env, {
          actorType: 'discord',
          actorId: String(user.id),
          actorName: String(user.username),
          action: 'submission.rejected',
          targetType: 'video',
          targetId: item.videoId,
          details: { error: (e as Error).message, url: item.url },
        });
        results.push({ url: item.url, videoId: item.videoId, status: 'invalid', title: item.title, detail: 'could not save' });
      }
    }
  }

  const count = await queueCount(env);
  if (settings.autoDispatch && count >= settings.threshold) {
    ctx.waitUntil(
      dispatchQueued(env, { requestedBy: `discord:${user.username}`, mode: 'auto' }).catch(() => {
        /* cron or the next submission retries */
      }),
    );
  }

  return json({
    ok: queued > 0,
    results,
    queueCount: count,
    threshold: settings.threshold,
    message: queued > 0 ? undefined : duplicates ? 'Already queued or already in the Aura library.' : 'Nothing was queued.',
    meta: { queued, duplicates, rejected },
  } satisfies SubmitResponse);
}

export async function handleConfig(env: Env): Promise<Response> {
  const settings = await loadSettings(env);
  const count = await queueCount(env);
  return json(settingsToConfig(settings, count) satisfies BotConfig);
}

export async function handleHeartbeat(env: Env, request: Request): Promise<Response> {
  let body: any;
  try {
    body = await readJson(request);
  } catch (e) {
    return error((e as Error).message, 400);
  }
  await env.DB.prepare(
    `UPDATE bot_status SET last_seen = ?, version = ?, guild_count = ?, latency_ms = ?, bot_user = ? WHERE id = 1`,
  )
    .bind(
      Date.now(),
      str(body.version, 40) || null,
      Number.isFinite(Number(body.guildCount)) ? Number(body.guildCount) : null,
      Number.isFinite(Number(body.latencyMs)) ? Math.trunc(Number(body.latencyMs)) : null,
      str(body.botUser, 100) || null,
    )
    .run();
  return json({ ok: true });
}

export async function handleEvents(env: Env, url: URL): Promise<Response> {
  const after = Math.max(0, Number(url.searchParams.get('after') || 0));
  const rows = await env.DB.prepare(
    `SELECT id, action, details, created_at FROM audit_log
     WHERE id > ? AND action LIKE 'batch.%' ORDER BY id ASC LIMIT 100`,
  )
    .bind(after)
    .all<{ id: number; action: string; details: string | null; created_at: number }>();
  const events = (rows.results || []).map((row) => {
    let details: Record<string, unknown> | null = null;
    try {
      details = row.details ? JSON.parse(row.details) : null;
    } catch {
      details = null;
    }
    return { id: row.id, action: row.action, details, createdAt: row.created_at };
  });
  return json({ events, lastId: events.length ? events[events.length - 1].id : after });
}

export async function handleQueuePreview(env: Env, url: URL): Promise<Response> {
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit') || 10)));
  const settings = await loadSettings(env);
  const count = await queueCount(env);
  const rows = await env.DB.prepare(
    `SELECT id, url, video_id, title, artist, username, discord_id, status, created_at
     FROM submissions WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?`,
  )
    .bind(limit)
    .all<any>();
  return json({
    count,
    threshold: settings.threshold,
    items: (rows.results || []).map((r) => ({
      id: r.id,
      url: r.url,
      videoId: r.video_id,
      title: r.title,
      artist: r.artist,
      username: r.username,
      discordId: r.discord_id,
      status: r.status,
      createdAt: r.created_at,
    })),
  });
}

export async function handleSearch(env: Env, request: Request): Promise<Response> {
  let body: any;
  try {
    body = await readJson(request);
  } catch (e) {
    return error((e as Error).message, 400);
  }
  const settings = await loadSettings(env);
  if (!settings.searchEnabled) return error('search is disabled', 403);
  const q = str(body.q, 200);
  if (q.length < 2) return error('type at least 2 characters', 400);
  try {
    const results = await auraSearch(env, q);
    const mapped: SearchResult[] = results.slice(0, 8).map((r) => ({
      videoId: r.videoId,
      title: r.title,
      sub: r.sub,
      duration: r.duration || null,
      thumbnail: r.thumbnail || null,
      isLive: Boolean(r.isLive),
    }));
    return json({ results: mapped, query: q });
  } catch (e) {
    return error((e as Error).message || 'search failed', 502);
  }
}

export async function handleExpand(env: Env, request: Request): Promise<Response> {
  let body: any;
  try {
    body = await readJson(request);
  } catch (e) {
    return error((e as Error).message, 400);
  }
  const settings = await loadSettings(env);
  if (!settings.playlistExpand) return error('playlist expansion is disabled', 403);
  const url = str(body.url, 500);
  if (!isPlaylistUrl(url) || !playlistIdFromUrl(url)) return error('send a YouTube playlist link', 400);
  try {
    const data = await auraExpand(env, url);
    const tracks = data.tracks.slice(0, 100).map((t) => {
      const [artist, album] = String(t.sub || '').split('•').map((v) => v.trim());
      return {
        url: canonicalVideoUrl(t.videoId),
        videoId: t.videoId,
        title: t.title,
        artist: artist || undefined,
        album: album || undefined,
      };
    });
    return json({ title: data.title, tracks });
  } catch (e) {
    return error((e as Error).message || 'playlist expansion failed', 502);
  }
}
