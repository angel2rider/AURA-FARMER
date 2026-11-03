export const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });

export const error = (message: string, status = 400): Response => json({ error: message }, status);

export async function readJson<T = any>(request: Request): Promise<T> {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 512 * 1024) throw new Error('request body too large');
  const text = await request.text();
  if (!text) throw new Error('empty request body');
  if (text.length > 512 * 1024) throw new Error('request body too large');
  return JSON.parse(text) as T;
}

export function bearer(request: Request): string {
  const value = request.headers.get('authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

export function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function str(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function auditDetails(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    const text = JSON.stringify(value);
    return text.length > 2000 ? text.slice(0, 2000) : text;
  } catch {
    return null;
  }
}
