import http from 'node:http';
import { log } from './logger';

export interface HealthSnapshot {
  ok: boolean;
  uptimeSec: number;
  bot: string | null;
  guilds: number;
  pingMs: number;
  queueConfigured: boolean;
  lastEventId: number;
}

export function startHealthServer(
  port: number,
  snapshot: () => HealthSnapshot,
): http.Server {
  const server = http.createServer((request, response) => {
    const path = (request.url || '/').split('?')[0];
    if (request.method === 'GET' && (path === '/' || path === '/health')) {
      const body = JSON.stringify({ ...snapshot(), now: Date.now() });
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(body);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });

  server.on('error', (error) => {
    log.error(`health server failed on :${port}`, error.message);
  });
  server.listen(port, '0.0.0.0', () => {
    log.info(`health endpoint listening on :${port}/health`);
  });
  return server;
}
