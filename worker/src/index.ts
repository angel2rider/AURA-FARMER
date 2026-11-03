import { APP_VERSION } from '../../src/shared/types';
import { handleAdmin } from './admin';
import { handleConfig, handleEvents, handleExpand, handleHeartbeat, handleQueuePreview, handleSearch, handleSubmit } from './bot';
import { runScheduled } from './dispatch';
import type { Env } from './env';
import { bearer, error, json, safeEqual } from './http';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-admin-email',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

function ingestAuth(env: Env, request: Request): boolean {
  return Boolean(env.BOT_INGEST_TOKEN) && safeEqual(bearer(request), env.BOT_INGEST_TOKEN);
}

function adminAuth(env: Env, request: Request): boolean {
  return Boolean(env.BOT_ADMIN_TOKEN) && safeEqual(bearer(request), env.BOT_ADMIN_TOKEN);
}

async function route(env: Env, request: Request, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (path === '/health' || path === '/') {
    return json({ ok: true, name: 'aura-farmer', version: APP_VERSION, now: Date.now() });
  }

  /* ----- admin RPC (called by the Aura Pages Function /api/bot) ----- */
  if (path === '/v1/admin') {
    if (request.method !== 'POST') return error('method not allowed', 405);
    if (!adminAuth(env, request)) return error('unauthorized', 401);
    const email = String(request.headers.get('x-admin-email') || 'admin').slice(0, 200);
    return handleAdmin(env, request, email);
  }

  /* ----- gateway (bot process on the VPS) ----- */
  if (path.startsWith('/v1/bot/')) {
    if (!ingestAuth(env, request)) return error('unauthorized', 401);
    const action = path.slice('/v1/bot/'.length);

    if (action === 'config' && request.method === 'GET') return handleConfig(env);
    if (action === 'events' && request.method === 'GET') return handleEvents(env, url);
    if (action === 'queue' && request.method === 'GET') return handleQueuePreview(env, url);
    if (action === 'submit' && request.method === 'POST') return handleSubmit(env, request, ctx);
    if (action === 'heartbeat' && request.method === 'POST') return handleHeartbeat(env, request);
    if (action === 'search' && request.method === 'POST') return handleSearch(env, request);
    if (action === 'expand' && request.method === 'POST') return handleExpand(env, request);

    return error('not found', 404);
  }

  return error('not found', 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return withCors(await route(env, request, ctx));
    } catch (e) {
      const message = (e as Error)?.message || 'internal error';
      console.error('worker error', message);
      return withCors(error(message, 500));
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runScheduled(env).catch((e) => {
        console.error('scheduled reconciliation failed', (e as Error)?.message || e);
      }),
    );
  },
};
