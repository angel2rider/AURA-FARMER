import { auraDispatch, auraRunUrl, auraRuns } from './aura';
import { activeBatch, audit, loadSettings, queueCount } from './db';
import type { Env } from './env';

export interface DispatchOptions {
  requestedBy: string;
  ids?: number[];
  force?: boolean;
  mode?: 'auto' | 'admin';
}

export interface DispatchResult {
  ok: boolean;
  dispatched: number;
  waiting?: boolean;
  reason?: string;
  batchId?: number;
  runId?: number | null;
  runUrl?: string | null;
  count?: number;
  skipped?: number;
  error?: string;
}

async function acquireLock(env: Env): Promise<boolean> {
  const now = Date.now();
  const until = now + 120_000;
  const res = await env.DB.prepare(
    `UPDATE settings SET value = ?, updated_at = ?
     WHERE key = 'dispatchLock' AND CAST(value AS INTEGER) < ?`,
  )
    .bind(String(until), now, now)
    .run();
  return Number(res.meta?.changes || 0) === 1;
}

async function releaseLock(env: Env): Promise<void> {
  await env.DB.prepare(`UPDATE settings SET value = '0', updated_at = ? WHERE key = 'dispatchLock'`)
    .bind(Date.now())
    .run();
}

async function selectQueued(env: Env, limit: number, ids?: number[]): Promise<any[]> {
  if (ids && ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT * FROM submissions WHERE status = 'queued' AND id IN (${placeholders}) ORDER BY created_at ASC LIMIT ?`,
    )
      .bind(...ids, Math.min(limit, 25))
      .all<any>();
    return rows.results || [];
  }
  const rows = await env.DB.prepare(
    `SELECT * FROM submissions WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?`,
  )
    .bind(Math.min(limit, 25))
    .all<any>();
  return rows.results || [];
}

export async function dispatchQueued(env: Env, options: DispatchOptions): Promise<DispatchResult> {
  const settings = await loadSettings(env);
  if (!settings.enabled && options.mode !== 'admin') {
    return { ok: false, dispatched: 0, waiting: true, reason: 'bot is disabled' };
  }
  if (settings.maintenance && options.mode !== 'admin') {
    return { ok: false, dispatched: 0, waiting: true, reason: 'maintenance mode' };
  }

  const locked = await acquireLock(env);
  if (!locked) return { ok: false, dispatched: 0, waiting: true, reason: 'another dispatch is already running' };

  try {
    const active = await activeBatch(env);
    if (active) {
      return {
        ok: false,
        dispatched: 0,
        waiting: true,
        reason: `batch #${active.id} is still ${active.status}`,
        batchId: active.id,
      };
    }

    const queued = await queueCount(env);
    const limit = options.ids?.length ? Math.min(options.ids.length, 25) : settings.dispatchSize;
    if (!options.force && queued < settings.threshold) {
      return { ok: true, dispatched: 0, waiting: true, reason: `queue has ${queued}/${settings.threshold}`, count: queued };
    }

    const selected = await selectQueued(env, limit, options.ids);
    if (!selected.length) {
      return { ok: true, dispatched: 0, waiting: true, reason: 'no queued submissions', count: queued };
    }

    /* GitHub cancels queued runs in the same concurrency group. Check before
       creating a batch so a busy upload does not produce noisy failures. */
    try {
      const runs = await auraRuns(env);
      const running = runs.find((r) => r.status === 'in_progress' || r.status === 'queued');
      if (running) {
        return {
          ok: false,
          dispatched: 0,
          waiting: true,
          reason: `Aura upload run #${running.id} is still ${running.status}`,
          runId: running.id,
          runUrl: running.html_url,
        };
      }
    } catch {
      /* best effort — dispatch itself is the final authority */
    }

    const now = Date.now();
    const insert = await env.DB.prepare(
      `INSERT INTO batches (status, track_count, requested_by, created_at) VALUES ('dispatching', ?, ?, ?)`,
    )
      .bind(selected.length, options.requestedBy.slice(0, 120), now)
      .run();
    const batchId = Number(insert.meta?.last_row_id || 0);
    if (!batchId) throw new Error('could not create batch');

    const ids = selected.map((s) => Number(s.id));
    const placeholders = ids.map(() => '?').join(',');
    await env.DB.prepare(
      `UPDATE submissions SET status = 'batched', batch_id = ?, updated_at = ? WHERE id IN (${placeholders}) AND status = 'queued'`,
    )
      .bind(batchId, now, ...ids)
      .run();

    const urls = selected.map((s) => `https://www.youtube.com/watch?v=${s.video_id}`);
    const meta = selected.map((s) => ({
      id: String(s.video_id),
      title: String(s.title || ''),
      artist: String(s.artist || ''),
      album: String(s.album || ''),
    }));

    let response: Awaited<ReturnType<typeof auraDispatch>>;
    try {
      response = await auraDispatch(env, urls, meta);
    } catch (e) {
      const message = (e as Error).message || 'dispatch failed';
      await env.DB.prepare(
        `UPDATE submissions SET status = 'queued', batch_id = NULL, error = ?, updated_at = ? WHERE batch_id = ? AND status = 'batched'`,
      )
        .bind(message.slice(0, 500), Date.now(), batchId)
        .run();
      await env.DB.prepare(`UPDATE batches SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`)
        .bind(message.slice(0, 500), Date.now(), batchId)
        .run();
      await audit(env, {
        actorType: options.mode === 'admin' ? 'admin' : 'system',
        actorName: options.requestedBy,
        action: 'batch.failed',
        targetType: 'batch',
        targetId: batchId,
        details: { error: message, count: selected.length },
      });
      return { ok: false, dispatched: 0, batchId, error: message, count: queued };
    }

    const skippedUploaded = new Set((response.skippedUploadedIds || []).map(String));
    for (const id of skippedUploaded) {
      await env.DB.prepare(
        `UPDATE submissions SET status = 'uploaded', updated_at = ? WHERE batch_id = ? AND video_id = ?`,
      )
        .bind(Date.now(), batchId, id)
        .run();
    }
    /* Anything else the Aura side refused as a duplicate would otherwise sit
       in "dispatched" forever and be marked downloaded by batch completion. */
    const skippedOther = new Set(
      (response.skippedIds || []).map(String).filter((id) => id && !skippedUploaded.has(id)),
    );
    for (const id of skippedOther) {
      await env.DB.prepare(
        `UPDATE submissions SET status = 'removed', error = ?, updated_at = ? WHERE batch_id = ? AND video_id = ? AND status = 'batched'`,
      )
        .bind('duplicate of another link in the same batch', Date.now(), batchId, id)
        .run();
    }
    await env.DB.prepare(
      `UPDATE submissions SET status = 'dispatched', updated_at = ? WHERE batch_id = ? AND status = 'batched'`,
    )
      .bind(Date.now(), batchId)
      .run();

    const dispatched = Number(response.dispatched || 0);
    const runId = Number(response.runId || 0) || null;
    const runUrl = runId ? auraRunUrl(runId) : null;
    const finalStatus = dispatched > 0 ? 'dispatched' : 'completed';
    await env.DB.prepare(
      `UPDATE batches SET status = ?, run_id = ?, run_url = ?, dispatched_at = ?, completed_at = ?, error = NULL WHERE id = ?`,
    )
      .bind(finalStatus, runId, runUrl, Date.now(), finalStatus === 'completed' ? Date.now() : null, batchId)
      .run();

    await audit(env, {
      actorType: options.mode === 'admin' ? 'admin' : 'system',
      actorName: options.requestedBy,
      action: 'batch.dispatched',
      targetType: 'batch',
      targetId: batchId,
      details: {
        batchId,
        count: selected.length,
        dispatched,
        skipped: Number(response.skipped || 0),
        skippedUploaded: Number(response.skippedUploaded || 0),
        runId,
        runUrl,
        requestedBy: options.requestedBy,
      },
    });

    return {
      ok: true,
      dispatched,
      batchId,
      runId,
      runUrl,
      count: await queueCount(env),
      skipped: Number(response.skipped || 0),
    };
  } finally {
    await releaseLock(env);
  }
}

export async function completeBatch(env: Env, batch: any, run: any): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE submissions SET status = 'downloaded', updated_at = ?
     WHERE batch_id = ? AND status IN ('batched','dispatched')`,
  )
    .bind(now, batch.id)
    .run();
  const done = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM submissions WHERE batch_id = ? AND status IN ('downloaded','uploaded')`,
  )
    .bind(batch.id)
    .first<{ c: number }>();
  await env.DB.prepare(`UPDATE batches SET status = 'completed', completed_at = ?, error = NULL WHERE id = ?`)
    .bind(now, batch.id)
    .run();
  await env.DB.prepare(
    `UPDATE users SET downloaded = downloaded + (
       SELECT COUNT(*) FROM submissions s
       WHERE s.batch_id = ? AND s.discord_id = users.discord_id AND s.status = 'downloaded'
     )
     WHERE discord_id IN (SELECT DISTINCT discord_id FROM submissions WHERE batch_id = ?)`,
  )
    .bind(batch.id, batch.id)
    .run();
  await audit(env, {
    actorType: 'system',
    actorName: 'Aura upload worker',
    action: 'batch.completed',
    targetType: 'batch',
    targetId: batch.id,
    details: {
      batchId: batch.id,
      runId: batch.run_id,
      runUrl: run?.html_url || batch.run_url,
      downloaded: Number(done?.c || 0),
      trackCount: batch.track_count,
    },
  });
}

export async function failBatch(env: Env, batch: any, reason: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE submissions SET status = 'failed', error = ?, updated_at = ?
     WHERE batch_id = ? AND status IN ('batched','dispatched')`,
  )
    .bind(reason.slice(0, 500), now, batch.id)
    .run();
  await env.DB.prepare(`UPDATE batches SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`)
    .bind(reason.slice(0, 500), now, batch.id)
    .run();
  await audit(env, {
    actorType: 'system',
    actorName: 'Aura upload worker',
    action: 'batch.failed',
    targetType: 'batch',
    targetId: batch.id,
    details: { batchId: batch.id, runId: batch.run_id, runUrl: batch.run_url, error: reason, trackCount: batch.track_count },
  });
}

export async function reconcileBatches(env: Env): Promise<{ checked: number; completed: number; failed: number }> {
  const rows = await env.DB.prepare(
    `SELECT * FROM batches WHERE status IN ('dispatching','dispatched','running') ORDER BY id ASC LIMIT 20`,
  ).all<any>();
  const batches = rows.results || [];
  if (!batches.length) return { checked: 0, completed: 0, failed: 0 };

  let runs: Awaited<ReturnType<typeof auraRuns>> = [];
  try {
    runs = await auraRuns(env);
  } catch {
    /* Aura API unreachable — leave active batches alone and try next cron */
    return { checked: batches.length, completed: 0, failed: 0 };
  }
  let completed = 0;
  let failed = 0;

  for (const batch of batches) {
    if (!batch.run_id) {
      if (Date.now() - Number(batch.created_at) > 5 * 60_000) {
        await failBatch(env, batch, 'dispatch did not complete — no GitHub run was recorded');
        failed++;
      }
      continue;
    }

    /* The dispatch response's run id is best-effort: GitHub can take a moment
       to register a new run, and a stale id would make us mark the batch done
       from an older run. Only accept a run created around/after the dispatch,
       and re-match if the stored id points somewhere older. */
    const dispatchedAt = Number(batch.dispatched_at || batch.created_at);
    const candidates = runs
      .filter((r) => new Date(r.created_at).getTime() >= dispatchedAt - 10 * 60_000)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    let run = candidates.find((r) => Number(r.id) === Number(batch.run_id));
    if (!run && candidates.length) {
      run = candidates[0];
      await env.DB.prepare(`UPDATE batches SET run_id = ?, run_url = ? WHERE id = ?`)
        .bind(Number(run.id), run.html_url, batch.id)
        .run();
    }

    if (!run) {
      if (Date.now() - dispatchedAt > 6 * 60 * 60_000) {
        await failBatch(env, batch, 'GitHub run is no longer available');
        failed++;
      }
      continue;
    }
    if (run.status === 'completed') {
      if (run.conclusion === 'success') {
        await completeBatch(env, batch, run);
        completed++;
      } else {
        await failBatch(env, batch, `upload workflow finished with ${run.conclusion || 'an error'}`);
        failed++;
      }
    } else if (batch.status !== 'running') {
      await env.DB.prepare(`UPDATE batches SET status = 'running' WHERE id = ?`).bind(batch.id).run();
    }
  }
  return { checked: batches.length, completed, failed };
}

export async function runScheduled(env: Env): Promise<void> {
  await reconcileBatches(env);
  const settings = await loadSettings(env);
  if (!settings.enabled) return;
  if (settings.maintenance) return;
  if (settings.autoDispatch) {
    const count = await queueCount(env);
    if (count >= settings.threshold) {
      await dispatchQueued(env, { requestedBy: 'auto schedule', mode: 'auto' });
    }
  }
}
