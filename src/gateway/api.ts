import type {
  AdminQueueResponse,
  BotConfig,
  SearchResult,
  SubmitPayload,
  SubmitResponse,
  WorkerEvent,
} from '../shared/types';

export class WorkerApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown = null) {
    super(message);
    this.name = 'WorkerApiError';
    this.status = status;
    this.body = body;
  }
}

export interface ExpandResult {
  title: string;
  tracks: Array<{
    url: string;
    videoId: string;
    title: string;
    artist?: string;
    album?: string;
  }>;
}

export class WorkerApi {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        ...init,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers || {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new WorkerApiError(`worker unreachable: ${(e as Error).message}`, 0);
    }
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      throw new WorkerApiError(body?.error || `worker returned HTTP ${res.status}`, res.status, body);
    }
    return body as T;
  }

  config(): Promise<BotConfig> {
    return this.request<BotConfig>('/v1/bot/config', {}, 10_000);
  }

  submit(payload: SubmitPayload): Promise<SubmitResponse> {
    return this.request<SubmitResponse>(
      '/v1/bot/submit',
      { method: 'POST', body: JSON.stringify(payload) },
      45_000,
    );
  }

  search(q: string): Promise<{ results: SearchResult[]; query: string }> {
    return this.request('/v1/bot/search', { method: 'POST', body: JSON.stringify({ q }) }, 30_000);
  }

  expand(url: string): Promise<ExpandResult> {
    return this.request('/v1/bot/expand', { method: 'POST', body: JSON.stringify({ url }) }, 45_000);
  }

  queue(limit = 10): Promise<{
    count: number;
    threshold: number;
    items: Array<{
      id: number;
      url: string;
      videoId: string;
      title: string | null;
      artist: string | null;
      username: string;
      discordId: string;
      status: string;
      createdAt: number;
    }>;
  }> {
    return this.request(`/v1/bot/queue?limit=${limit}`, {}, 10_000);
  }

  events(after: number): Promise<{ events: WorkerEvent[]; lastId: number }> {
    return this.request(`/v1/bot/events?after=${Math.max(0, after)}`, {}, 10_000);
  }

  heartbeat(payload: {
    version: string;
    botUser: string;
    guildCount: number;
    latencyMs: number;
  }): Promise<{ ok: boolean }> {
    return this.request(
      '/v1/bot/heartbeat',
      { method: 'POST', body: JSON.stringify(payload) },
      10_000,
    );
  }
}

export type { AdminQueueResponse };
