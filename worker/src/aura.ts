import type { Env } from './env';

export interface AuraSearchResult {
  videoId: string;
  title: string;
  sub: string;
  extra?: string;
  duration: string | null;
  thumbnail: string | null;
  isLive: boolean;
}

export interface AuraExpandTrack {
  videoId: string;
  title: string;
  sub: string;
  duration?: string | null;
  thumbnail?: string | null;
}

export interface AuraRun {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  html_url: string;
  display_title: string;
}

export class AuraApiError extends Error {
  status: number;
  body: any;
  constructor(message: string, status: number, body: any = null) {
    super(message);
    this.name = 'AuraApiError';
    this.status = status;
    this.body = body;
  }
}

async function auraPost<T>(env: Env, payload: Record<string, unknown>, timeoutMs = 25_000): Promise<T> {
  const base = (env.AURA_API_URL || '').replace(/\/$/, '');
  if (!base || !env.AURA_SERVICE_TOKEN) {
    throw new AuraApiError('Aura API is not configured on the worker', 503);
  }
  let res: Response;
  try {
    res = await fetch(base + '/api/admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, service_token: env.AURA_SERVICE_TOKEN }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new AuraApiError('Aura API request failed: ' + ((e as Error).message || 'network error'), 502);
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new AuraApiError(body?.error || `Aura API returned HTTP ${res.status}`, res.status, body);
  }
  return body as T;
}

export async function auraSearch(env: Env, q: string): Promise<AuraSearchResult[]> {
  const data = await auraPost<{ results: AuraSearchResult[] }>(env, { action: 'search', q, mode: 'music' });
  return (data.results || []).filter((r) => r && r.videoId && !r.isLive);
}

export async function auraExpand(env: Env, url: string): Promise<{ title: string; tracks: AuraExpandTrack[] }> {
  const data = await auraPost<{ title?: string; tracks: AuraExpandTrack[] }>(env, { action: 'expand', url }, 35_000);
  return { title: data.title || 'YouTube playlist', tracks: data.tracks || [] };
}

export async function auraDispatch(
  env: Env,
  urls: string[],
  meta: Array<{ id: string; title: string; artist: string; album: string }>,
): Promise<{
  ok: boolean;
  dispatched: number;
  chained?: number;
  runs?: number;
  skipped?: number;
  skippedIds?: string[];
  skippedUploaded?: number;
  skippedUploadedIds?: string[];
  runId?: number;
}> {
  return auraPost(env, { action: 'dispatch', urls, meta }, 45_000);
}

export async function auraRuns(env: Env): Promise<AuraRun[]> {
  const data = await auraPost<{ runs: AuraRun[] }>(env, { action: 'runs' }, 15_000);
  return data.runs || [];
}

export async function auraRunJobs(env: Env, runId: number): Promise<any[]> {
  const data = await auraPost<{ jobs: any[] }>(env, { action: 'runJobs', run_id: runId }, 15_000);
  return data.jobs || [];
}

export function auraRunUrl(runId: number): string {
  return `https://github.com/abhinavthewc-quick/aura-music/actions/runs/${runId}`;
}
