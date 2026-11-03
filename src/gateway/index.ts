import { WorkerApi } from './api';
import { AuraBot, envChannelIds } from './bot';
import { loadConfig } from './config';
import { startHealthServer } from './health';
import { log, setLogLevel } from './logger';
import { Outbox, StateStore } from './outbox';

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const api = new WorkerApi(config.workerUrl, config.ingestToken);
  const outbox = new Outbox(config.outboxPath);
  const state = new StateStore(config.statePath);
  await state.load();

  const bot = new AuraBot({
    token: config.token,
    clientId: config.clientId,
    guildId: config.guildId,
    channelIds: envChannelIds(process.env.DISCORD_CHANNEL_ID),
    api,
    outbox,
    state,
  });

  const server = startHealthServer(config.healthPort, () => ({
    ok: bot.client.isReady(),
    uptimeSec: Math.round(process.uptime()),
    bot: bot.client.user?.tag || null,
    guilds: bot.client.guilds.cache.size,
    pingMs: Math.max(0, Math.round(bot.client.ws.ping)),
    queueConfigured: true,
    lastEventId: state.lastEventId,
  }));

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received — shutting down`);
    server.close();
    try {
      await bot.stop();
    } catch (error) {
      log.warn('shutdown error', (error as Error).message);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await bot.start();
  } catch (error) {
    const message = (error as Error).message || String(error);
    log.error('could not start the Discord gateway', message);
    if (/disallowed intents/i.test(message)) {
      log.error('Enable “Message Content Intent” in the Discord Developer Portal → Bot → Privileged Gateway Intents.');
    }
    if (/invalid token|An invalid token/i.test(message)) {
      log.error('Check DISCORD_TOKEN — use the Bot token, not the client secret.');
    }
    server.close();
    process.exit(1);
  }

  log.info('Aura Farmer gateway is running');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
