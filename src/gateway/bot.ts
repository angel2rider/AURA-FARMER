import {
  ActionRowBuilder,
  ActivityType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  REST,
  Routes,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
  type Message,
  type StringSelectMenuInteraction,
  type TextBasedChannel,
} from 'discord.js';
import { APP_VERSION, type BotConfig, type SearchResult, type SubmitItemResult, type WorkerEvent } from '../shared/types';
import { channelList } from '../shared/settings';
import { canonicalVideoUrl, extractPlaylistUrls, extractVideoIds, isPlaylistUrl } from '../shared/urls';
import { WorkerApi, WorkerApiError, type ExpandResult } from './api';
import { COLORS, commandData, splitSub } from './commands';
import { log } from './logger';
import { Outbox, StateStore } from './outbox';

type SearchCacheEntry = {
  results: SearchResult[];
  userId: string;
  at: number;
};

const SEARCH_TTL_MS = 5 * 60_000;
const MAX_PLAYLIST_TRACKS = 100;

const FARM_REACTIONS = {
  queued: '🌱',      // planted
  duplicate: '🌿',   // already growing
  banned: '🚫',      // kicked off the farm
  blocked: '⏳',     // wait for harvest
  invalid: '🪨',     // that's a rock, not a seed
  offline: '🌧️',     // storm knocked out the silo
  playlist: '🚜',    // tractor loaded
  search: '🔍',      // scouting
} as const;

const FARM_MESSAGES = {
  queued: [
    '🌱 Planted! Your crop\'s in the queue.',
    '🌱 Seed saved. The harvest comes at {threshold}.',
    '🌱 Tucked into the soil. Waiting on {queued} more.',
  ],
  duplicate: [
    '🌿 Already growing that one — no double planting.',
    '🌿 That crop\'s already in the field.',
  ],
  banned: [
    '🚫 You\'ve been chased off the farm.',
    '🚫 No trespassing — the scarecrow saw you.',
  ],
  blocked: [
    '⏳ Soil needs rest. Try again in a bit.',
    '⏳ The well\'s dry. Wait for the cooldown.',
  ],
  invalid: [
    '🪨 That\'s a rock, not a seed. YouTube links only.',
    '🪨 Can\'t plant that. Needs a valid YouTube link.',
  ],
  offline: [
    '🌧️ Storm took the silo offline. Holding your seeds safe.',
    '🌧️ Silo\'s down. Your batch is stored in the barn.',
  ],
  playlist: [
    '🚜 Tractor loaded with {count} crops from that playlist.',
    '🚜 Harvested {count} tracks from the playlist.',
  ],
  thresholdHit: [
    '🌾 **{queued} planted** — **{count}/{threshold}** Silo full! Harvest beginning...',
    '🌾 **{queued} seeds sown** — **{count}/{threshold}** The combine\'s rolling out!',
  ],
  queuedSimple: [
    '🌱 **{queued} planted** — **{count}/{threshold}** in the silo.',
    '🌱 **{queued} saved** — **{count}/{threshold}** waiting for harvest.',
  ],
  playlistQueued: [
    '🚜 **{title}** — **{queued} crops** harvested{duplicates}. Silo: **{count}/{threshold}**.',
  ],
  searchPrompt: '🔍 Scouting the fields for **{query}** — pick your seeds:',
  searchEmpty: '🔍 Nothin\' growin\' for **{query}**. Try another search.',
  help: [
    '🌾 **AURA FARMER** — We grow the beats so you don\'t have to.',
    '',
    '🌱 **Plant a seed:** Drop a YouTube/YouTube Music link in the channel.',
    '🚜 **Harvest a field:** `/playlist <url>` — up to 100 tracks.',
    '🔍 **Scout the fields:** `/find <query>` — search & pick.',
    '📦 **Check the silo:** `/queue` — what\'s waiting.',
    '📊 **Farm report:** `/status` — how\'s the harvest.',
    '',
    '⚙️ Silo threshold: **{threshold}** | Combine capacity: **25**',
  ].join('\n'),
} as const;

function defaultConfig(): BotConfig {
  return {
    enabled: false,
    maintenance: false,
    maintenanceMessage: 'The farm\'s closed for maintenance. Scarecrow\'s on break.',
    threshold: 20,
    queueCount: 0,
    guildId: '',
    channelIds: [],
    logChannelId: '',
    searchEnabled: true,
    playlistExpand: true,
    cooldownSeconds: 0,
    dailyLimit: 0,
    botName: 'AURA FARMER',
  };
}

function isTextChannel(channel: unknown): channel is TextBasedChannel & { send: (options: any) => Promise<any> } {
  return Boolean(channel && typeof (channel as any).send === 'function');
}

function resultEmoji(results: SubmitItemResult[]): string {
  const statuses = new Set(results.map((result) => result.status));
  if (statuses.has('banned')) return FARM_REACTIONS.banned;
  if (statuses.has('cooldown') || statuses.has('limit')) return FARM_REACTIONS.blocked;
  if (statuses.has('queued')) return FARM_REACTIONS.queued;
  if (statuses.has('duplicate')) return FARM_REACTIONS.duplicate;
  return FARM_REACTIONS.invalid;
}

function summarizeResults(results: SubmitItemResult[]): string {
  const counts = new Map<string, number>();
  for (const result of results) {
    counts.set(result.status, (counts.get(result.status) || 0) + 1);
  }
  const parts: string[] = [];
  for (const [status, count] of counts) {
    const label =
      status === 'queued'
        ? 'queued'
        : status === 'duplicate'
          ? 'already queued'
          : status === 'uploaded'
            ? 'already in Aura'
            : status;
    parts.push(`${count} ${label}`);
  }
  return parts.join(' · ');
}

export class AuraBot {
  readonly client: Client;
  private api: WorkerApi;
  private outbox: Outbox;
  private state: StateStore;
  private cfg: BotConfig = defaultConfig();
  private fallbackGuildId: string;
  private fallbackChannelIds: string[];
  private token: string;
  private clientId: string;
  private searchCache = new Map<string, SearchCacheEntry>();
  private configTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private eventTimer?: NodeJS.Timeout;
  private outboxTimer?: NodeJS.Timeout;
  private presenceTimer?: NodeJS.Timeout;
  private warnedNoChannel = false;
  private stopping = false;

  constructor(options: {
    token: string;
    clientId: string;
    guildId: string;
    channelIds: string[];
    api: WorkerApi;
    outbox: Outbox;
    state: StateStore;
  }) {
    this.token = options.token;
    this.clientId = options.clientId;
    this.fallbackGuildId = options.guildId;
    this.fallbackChannelIds = options.channelIds;
    this.api = options.api;
    this.outbox = options.outbox;
    this.state = options.state;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    this.client.on(Events.MessageCreate, (message) => {
      void this.onMessage(message).catch((error) =>
        log.error('message handler failed', (error as Error).message),
      );
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.onInteraction(interaction as any).catch((error) =>
        log.error('interaction handler failed', (error as Error).message),
      );
    });
    this.client.on(Events.Error, (error) => log.error('discord client error', error.message));
    this.client.on(Events.Warn, (warning) => log.warn('discord warning', warning));
  }

  async start(): Promise<void> {
    await this.outbox.load();
    await this.state.load();
    await this.refreshConfig(true);

    this.client.once(Events.ClientReady, () => {
      void this.onReady().catch((error) => log.error('ready handler failed', (error as Error).message));
    });

    await this.client.login(this.token);
    this.startTimers();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of [
      this.configTimer,
      this.heartbeatTimer,
      this.eventTimer,
      this.outboxTimer,
      this.presenceTimer,
    ]) {
      if (timer) clearInterval(timer);
    }
    try {
      await this.outbox.flush(async (payload) => {
        await this.api.submit(payload as any);
      });
    } catch {
      /* keep the outbox for the next boot */
    }
    this.client.destroy();
  }

  private channelIds(): string[] {
    return this.cfg.channelIds.length ? this.cfg.channelIds : this.fallbackChannelIds;
  }

  private guildId(): string {
    return this.cfg.guildId || this.fallbackGuildId;
  }

  private async onReady(): Promise<void> {
    log.info(`logged in as ${this.client.user?.tag || 'unknown'}`);
    try {
      await this.registerCommands();
    } catch (error) {
      log.error('slash command registration failed', (error as Error).message);
    }
    await this.pollEvents();
    await this.updatePresence();
    const channels = this.channelIds();
    if (!channels.length) {
      log.warn('no submission channels configured — set them in the admin panel or DISCORD_CHANNEL_ID');
    } else {
      log.info(`listening in ${channels.join(', ')}`);
    }
  }

  private async registerCommands(): Promise<void> {
    const rest = new REST().setToken(this.token);
    const guildId = this.guildId();
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(this.clientId, guildId), {
        body: commandData,
      });
      log.info(`registered slash commands in guild ${guildId}`);
    } else {
      await rest.put(Routes.applicationCommands(this.clientId), { body: commandData });
      log.info('registered global slash commands (may take up to an hour to appear)');
    }
  }

  private startTimers(): void {
    this.configTimer = setInterval(() => {
      void this.refreshConfig(false);
    }, 30_000);
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat();
    }, 30_000);
    this.eventTimer = setInterval(() => {
      void this.pollEvents();
    }, 15_000);
    this.outboxTimer = setInterval(() => {
      void this.flushOutbox();
    }, 30_000);
    this.presenceTimer = setInterval(() => {
      void this.updatePresence();
    }, 30_000);
    void this.sendHeartbeat();
    void this.updatePresence();
  }

  private async refreshConfig(initial: boolean): Promise<void> {
    try {
      this.cfg = await this.api.config();
      if (initial) {
        log.info(
          `config: ${this.cfg.enabled ? 'enabled' : 'disabled'} · ${this.cfg.queueCount}/${this.cfg.threshold} queued`,
        );
      }
      if (this.cfg.maintenance) log.warn('maintenance mode is on');
    } catch (error) {
      const message = (error as Error).message;
      if (initial) log.warn(`could not load config — using defaults (${message})`);
      else log.warn(`config refresh failed: ${message}`);
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.client.isReady() || this.stopping) return;
    try {
      await this.api.heartbeat({
        version: APP_VERSION,
        botUser: this.client.user?.tag || '',
        guildCount: this.client.guilds.cache.size,
        latencyMs: Math.max(0, Math.round(this.client.ws.ping)),
      });
    } catch (error) {
      log.warn('heartbeat failed', (error as Error).message);
    }
  }

  private async updatePresence(): Promise<void> {
    if (!this.client.isReady()) return;
    try {
      this.client.user?.setPresence({
        activities: [
          {
            name: `🌱 ${this.cfg.queueCount}/${this.cfg.threshold} in the silo · /help`,
            type: ActivityType.Watching,
          },
        ],
        status: this.cfg.enabled && !this.cfg.maintenance ? 'online' : 'idle',
      });
    } catch {
      /* presence is cosmetic */
    }
  }

  private async flushOutbox(): Promise<void> {
    try {
      const sent = await this.outbox.flush(async (payload) => {
        try {
          await this.api.submit(payload as any);
        } catch (error) {
          /* A 4xx (other than rate limiting) will never succeed on retry. */
          if (
            error instanceof WorkerApiError &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status !== 429
          ) {
            return;
          }
          throw error;
        }
      });
      if (sent) log.info(`outbox: delivered ${sent} held submission(s)`);
    } catch (error) {
      log.warn('outbox flush failed', (error as Error).message);
    }
  }

  private async pollEvents(): Promise<void> {
    if (this.stopping) return;
    try {
      const { events, lastId } = await this.api.events(this.state.lastEventId);
      for (const event of events) {
        await this.announceEvent(event);
      }
      if (lastId > this.state.lastEventId) await this.state.setLastEventId(lastId);
    } catch (error) {
      log.warn('event poll failed', (error as Error).message);
    }
  }

  private async announceEvent(event: WorkerEvent): Promise<void> {
    const details = (event.details || {}) as Record<string, any>;
    let embed: EmbedBuilder | null = null;
    if (event.action === 'batch.dispatched') {
      embed = new EmbedBuilder()
        .setColor(COLORS.gold)
        .setTitle(`🚜 Harvest #${details.batchId ?? '?'} — Combine rolling out!`)
        .setDescription(
          `**${details.dispatched ?? details.count ?? 0} crops** sent to the Aura silo.`,
        )
        .addFields(
          { name: '👨‍🌾 Called by', value: String(details.requestedBy || 'auto schedule'), inline: true },
          { name: '📦 Still in field', value: String(details.remaining ?? '—'), inline: true },
        );
      if (details.runUrl) embed.setURL(String(details.runUrl));
    } else if (event.action === 'batch.completed') {
      embed = new EmbedBuilder()
        .setColor(COLORS.green)
        .setTitle(`🌾 Harvest #${details.batchId ?? '?'} — Brought in!`)
        .setDescription(
          `**${details.downloaded ?? details.trackCount ?? 0} crops** stored in the Aura barn.`,
        );
      if (details.runUrl) embed.setURL(String(details.runUrl));
    } else if (event.action === 'batch.failed') {
      embed = new EmbedBuilder()
        .setColor(COLORS.red)
        .setTitle(`🌧️ Harvest #${details.batchId ?? '?'} — Storm damage!`)
        .setDescription(String(details.error || 'The combine broke down.').slice(0, 1900));
      if (details.runUrl) embed.setURL(String(details.runUrl));
    }
    if (!embed) return;

    const targetId = this.cfg.logChannelId || this.channelIds()[0];
    if (!targetId) return;
    try {
      const channel = await this.client.channels.fetch(targetId);
      if (isTextChannel(channel)) await channel.send({ embeds: [embed] });
    } catch (error) {
      log.warn(`could not announce ${event.action}`, (error as Error).message);
    }
  }

  private async onMessage(message: Message): Promise<void> {
    if (this.stopping || message.author.bot || !message.inGuild()) return;
    const guildId = this.guildId();
    if (guildId && message.guildId !== guildId) return;
    const channels = this.channelIds();
    if (!channels.includes(message.channelId)) {
      if (!this.warnedNoChannel && !channels.length) {
        this.warnedNoChannel = true;
        log.warn('ignoring messages because no submission channel is configured');
      }
      return;
    }

    const text = message.content || '';
    const videos = extractVideoIds(text);
    const playlists = extractPlaylistUrls(text);

    if (!videos.length && !playlists.length) {
      return;
    }

    if (playlists.length && !videos.length) {
      await this.submitPlaylistMessage(message, playlists[0]);
      return;
    }

    await this.submitMessage(message, videos.map((videoId) => ({ videoId })));
  }

  private async submitMessage(
    message: Message,
    entries: Array<{ videoId: string; title?: string; artist?: string; album?: string }>,
  ): Promise<void> {
    if (!message.channel || !isTextChannel(message.channel)) return;
    const payload = {
      guildId: message.guildId || undefined,
      channelId: message.channelId,
      messageId: message.id,
      user: {
        id: message.author.id,
        username: message.author.username,
        displayName: message.member?.displayName || message.author.globalName || message.author.username,
        avatarUrl: message.author.displayAvatarURL({ size: 128 }),
      },
      items: entries.slice(0, 25).map((entry) => ({
        url: canonicalVideoUrl(entry.videoId),
        videoId: entry.videoId,
        title: entry.title,
        artist: entry.artist,
        album: entry.album,
        source: 'message' as const,
        clientKey: `${message.id}:${entry.videoId}`,
      })),
    };

    try {
      const response = await this.api.submit(payload);
      const emoji = resultEmoji(response.results);
      await this.react(message, emoji);
      this.cfg.queueCount = response.queueCount;
      void this.updatePresence();
      const queued = response.results.filter((result) => result.status === 'queued').length;
      if (queued === 0 && response.message) {
        await this.reply(message, response.message);
      } else if (response.queueCount >= response.threshold && queued > 0) {
        const msg = FARM_MESSAGES.thresholdHit[Math.floor(Math.random() * FARM_MESSAGES.thresholdHit.length)]
          .replace('{queued}', String(queued))
          .replace('{count}', String(response.queueCount))
          .replace('{threshold}', String(response.threshold));
        await this.reply(message, msg);
      } else if (queued > 0) {
        const msg = FARM_MESSAGES.queuedSimple[Math.floor(Math.random() * FARM_MESSAGES.queuedSimple.length)]
          .replace('{queued}', String(queued))
          .replace('{count}', String(response.queueCount))
          .replace('{threshold}', String(response.threshold));
        await this.reply(message, msg);
      }
    } catch (error) {
      if (error instanceof WorkerApiError && error.status === 0) {
        await this.outbox.add(payload);
        await this.react(message, FARM_REACTIONS.offline);
        log.warn('worker unreachable — submission held in outbox');
        return;
      }
      await this.react(message, FARM_REACTIONS.invalid);
      log.error('submission failed', (error as Error).message);
    }
  }

  private async submitPlaylistMessage(message: Message, url: string): Promise<void> {
    if (!message.channel || !isTextChannel(message.channel)) return;
    if (!this.cfg.playlistExpand) {
      await this.reply(message, "🚜 The combine's in the barn — playlist expansion disabled. Drop single links instead.");
      return;
    }
    if (!isPlaylistUrl(url)) {
      await this.react(message, FARM_REACTIONS.invalid);
      return;
    }
    await this.react(message, FARM_REACTIONS.search);
    let expanded: ExpandResult;
    try {
      expanded = await this.api.expand(url);
    } catch (error) {
      await this.react(message, FARM_REACTIONS.invalid);
      await this.reply(message, `🪨 Couldn't harvest that field: ${(error as Error).message}`);
      return;
    }
    if (!expanded.tracks.length) {
      await this.reply(message, "🪨 That field's empty — no tracks to harvest.");
      return;
    }
    const tracks = expanded.tracks.slice(0, MAX_PLAYLIST_TRACKS);
    const chunks: ExpandResult['tracks'][] = [];
    for (let i = 0; i < tracks.length; i += 50) chunks.push(tracks.slice(i, i + 50));

    let queued = 0;
    let duplicates = 0;
    let lastCount = 0;
    let lastThreshold = this.cfg.threshold;
    for (const chunk of chunks) {
      try {
        const response = await this.api.submit({
          guildId: message.guildId || undefined,
          channelId: message.channelId,
          messageId: message.id,
          user: {
            id: message.author.id,
            username: message.author.username,
            displayName: message.member?.displayName || message.author.globalName || message.author.username,
            avatarUrl: message.author.displayAvatarURL({ size: 128 }),
          },
          items: chunk.map((track) => ({
            url: track.url || canonicalVideoUrl(track.videoId),
            videoId: track.videoId,
            title: track.title,
            artist: track.artist,
            album: track.album,
            source: 'playlist' as const,
            clientKey: `${message.id}:${track.videoId}`,
          })),
        });
        for (const result of response.results) {
          if (result.status === 'queued') queued++;
          if (result.status === 'duplicate' || result.status === 'uploaded') duplicates++;
        }
        lastCount = response.queueCount;
        lastThreshold = response.threshold;
      } catch (error) {
        if (error instanceof WorkerApiError && error.status === 0) {
          await this.outbox.add({
            guildId: message.guildId || undefined,
            channelId: message.channelId,
            messageId: message.id,
            user: {
              id: message.author.id,
              username: message.author.username,
              displayName: message.member?.displayName || message.author.globalName || message.author.username,
              avatarUrl: message.author.displayAvatarURL({ size: 128 }),
            },
            items: chunk.map((track) => ({
              url: track.url || canonicalVideoUrl(track.videoId),
              videoId: track.videoId,
              title: track.title,
              artist: track.artist,
              album: track.album,
              source: 'playlist' as const,
              clientKey: `${message.id}:${track.videoId}`,
            })),
          });
        }
      }
    }

    this.cfg.queueCount = lastCount;
    void this.updatePresence();
    await this.react(message, queued ? FARM_REACTIONS.playlist : FARM_REACTIONS.duplicate);
    const dupText = duplicates ? ` (🌿 ${duplicates} already growin')` : '';
    const msg = FARM_MESSAGES.playlistQueued[0]
      .replace('{title}', expanded.title)
      .replace('{queued}', String(queued))
      .replace('{duplicates}', dupText)
      .replace('{count}', String(lastCount))
      .replace('{threshold}', String(lastThreshold));
    await this.reply(message, msg);
  }
  private async searchInChannel(message: Message, query: string): Promise<void> {
    if (!message.channel || !isTextChannel(message.channel)) return;
    try {
      const { results } = await this.api.search(query);
      if (!results.length) {
        await this.reply(message, `No music found for **${query}**.`);
        return;
      }
      const id = this.cacheSearch(results, message.author.id);
      await message.channel.send({
        content: `Results for **${query}** — pick a track to queue.`,
        components: [this.searchRow(id, results)],
      });
    } catch (error) {
      await this.reply(message, `Search failed: ${(error as Error).message}`);
    }
  }

  private cacheSearch(results: SearchResult[], userId: string): string {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.searchCache.set(id, { results, userId, at: Date.now() });
    for (const [key, entry] of this.searchCache) {
      if (Date.now() - entry.at > SEARCH_TTL_MS) this.searchCache.delete(key);
    }
    return id;
  }

  private searchRow(cacheId: string, results: SearchResult[]): ActionRowBuilder<StringSelectMenuBuilder> {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`aura:pick:${cacheId}`)
      .setPlaceholder('Choose up to 5 tracks to queue')
      .setMinValues(1)
      .setMaxValues(Math.min(5, results.length));
    for (const result of results.slice(0, 25)) {
      const option = new StringSelectMenuOptionBuilder()
        .setLabel(result.title.slice(0, 100) || result.videoId)
        .setValue(result.videoId);
      const description = [result.sub, result.duration].filter(Boolean).join(' · ');
      if (description) option.setDescription(description.slice(0, 100));
      menu.addOptions(option);
    }
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  }

  private async onInteraction(interaction: any): Promise<void> {
    if (this.stopping) return;
    if (interaction.isChatInputCommand()) {
      await this.onCommand(interaction);
      return;
    }
    if (interaction.isStringSelectMenu() && String(interaction.customId).startsWith('aura:pick:')) {
      await this.onPick(interaction);
    }
  }

  private async onCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    switch (interaction.commandName) {
      case 'find':
        await this.onFind(interaction);
        return;
      case 'playlist':
        await this.onPlaylistCommand(interaction);
        return;
      case 'queue':
        await this.onQueueCommand(interaction);
        return;
      case 'status':
        await this.onStatusCommand(interaction);
        return;
      case 'help':
        await this.onHelpCommand(interaction);
        return;
      default:
        await interaction.reply({ content: 'Unknown command.', flags: MessageFlags.Ephemeral });
    }
  }

  private commandChannelAllowed(channelId: string): boolean {
    const channels = this.channelIds();
    return !channels.length || channels.includes(channelId);
  }

  private async requireCommandChannel(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (this.commandChannelAllowed(interaction.channelId)) return true;
    const first = this.channelIds()[0];
    await interaction.reply({
      content: first
        ? `Please use that command in <#${first}>.`
        : 'No submission channel is configured yet.',
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  private async onFind(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.cfg.searchEnabled) {
      await interaction.reply({ content: 'Search is disabled right now.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!(await this.requireCommandChannel(interaction))) return;
    const query = interaction.options.getString('query', true).trim();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { results } = await this.api.search(query);
      if (!results.length) {
        const msg = FARM_MESSAGES.searchEmpty.replace('{query}', query);
        await interaction.editReply(msg);
        return;
      }
      const id = this.cacheSearch(results, interaction.user.id);
      const msg = FARM_MESSAGES.searchPrompt.replace('{query}', query);
      await interaction.editReply({
        content: msg,
        components: [this.searchRow(id, results)],
      });
    } catch (error) {
      await interaction.editReply(`🪨 Search failed: ${(error as Error).message}`);
    }
  }

  private async onPick(interaction: StringSelectMenuInteraction): Promise<void> {
    const cacheId = interaction.customId.slice('aura:pick:'.length);
    const entry = this.searchCache.get(cacheId);
    if (!entry || Date.now() - entry.at > SEARCH_TTL_MS) {
      await interaction.reply({
        content: '🌧️ That harvest\'s expired — run `/find` again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (entry.userId !== interaction.user.id) {
      await interaction.reply({
        content: '🚜 That\'s another farmer\'s field — run `/find` yourself.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const picked = entry.results.filter((result) => interaction.values.includes(result.videoId));
    if (!picked.length) {
      await interaction.reply({ content: '🌧️ Those seeds blew away — run `/find` again.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const response = await this.api.submit({
        guildId: interaction.guildId || undefined,
        channelId: interaction.channelId,
        user: {
          id: interaction.user.id,
          username: interaction.user.username,
          displayName: interaction.member && 'displayName' in interaction.member
            ? String(interaction.member.displayName)
            : interaction.user.globalName || interaction.user.username,
          avatarUrl: interaction.user.displayAvatarURL({ size: 128 }),
        },
        items: picked.map((result) => {
          const { artist, album } = splitSub(result.sub);
          return {
            url: canonicalVideoUrl(result.videoId),
            videoId: result.videoId,
            title: result.title,
            artist,
            album,
            source: 'search' as const,
            clientKey: `${interaction.id}:${result.videoId}`,
          };
        }),
      });
      const queued = response.results.filter((result) => result.status === 'queued').length;
      this.cfg.queueCount = response.queueCount;
      void this.updatePresence();
      const dup = response.results.filter((r) => r.status === 'duplicate' || r.status === 'uploaded').length;
      const dupText = dup ? ` (🌿 ${dup} already growin')` : '';
      await interaction.editReply({
        content: `🌱 **${queued}/${picked.length} planted** · silo **${response.queueCount}/${response.threshold}**${dupText}.`,
      });
    } catch (error) {
      await interaction.editReply(`🪨 Couldn't plant that: ${(error as Error).message}`);
    }
  }

  private async onPlaylistCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.cfg.playlistExpand) {
      await interaction.reply({
        content: "🚜 The combine's in the barn — playlist expansion disabled.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!(await this.requireCommandChannel(interaction))) return;
    const url = interaction.options.getString('url', true).trim();
    if (!isPlaylistUrl(url)) {
      await interaction.reply({
        content: "🪨 That's not a YouTube playlist field.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let expanded: ExpandResult;
    try {
      expanded = await this.api.expand(url);
    } catch (error) {
      await interaction.editReply(`🪨 Couldn't harvest that field: ${(error as Error).message}`);
      return;
    }
    if (!expanded.tracks.length) {
      await interaction.editReply("🪨 That field's empty — no tracks to harvest.");
      return;
    }
    const tracks = expanded.tracks.slice(0, MAX_PLAYLIST_TRACKS);
    let queued = 0;
    let duplicate = 0;
    let count = 0;
    let threshold = this.cfg.threshold;
    for (let i = 0; i < tracks.length; i += 50) {
      const chunk = tracks.slice(i, i + 50);
      try {
        const response = await this.api.submit({
          guildId: interaction.guildId || undefined,
          channelId: interaction.channelId,
          user: {
            id: interaction.user.id,
            username: interaction.user.username,
            displayName: interaction.user.globalName || interaction.user.username,
            avatarUrl: interaction.user.displayAvatarURL({ size: 128 }),
          },
          items: chunk.map((track) => ({
            url: track.url || canonicalVideoUrl(track.videoId),
            videoId: track.videoId,
            title: track.title,
            artist: track.artist,
            album: track.album,
            source: 'playlist' as const,
            clientKey: `${interaction.id}:${track.videoId}`,
          })),
        });
        for (const result of response.results) {
          if (result.status === 'queued') queued++;
          if (result.status === 'duplicate' || result.status === 'uploaded') duplicate++;
        }
        count = response.queueCount;
        threshold = response.threshold;
      } catch (error) {
        await interaction.editReply(`🪨 Harvest stopped: ${(error as Error).message}`);
        return;
      }
    }
    const dupText = duplicate ? ` (🌿 ${duplicate} already growin')` : '';
    const msg = FARM_MESSAGES.playlistQueued[0]
      .replace('{title}', expanded.title)
      .replace('{queued}', String(queued))
      .replace('{duplicates}', dupText)
      .replace('{count}', String(count))
      .replace('{threshold}', String(threshold));
    await interaction.editReply(msg);
  }

  private async onQueueCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const data = await this.api.queue(10);
      const embed = new EmbedBuilder()
        .setColor(COLORS.gold)
        .setTitle('🌾 AURA FARMER — Silo Contents')
        .setDescription(`**${data.count}/${data.threshold}** crops waiting for harvest.`);
      if (data.items.length) {
        const lines = data.items.map(
          (item, index) =>
            `**${index + 1}.** ${item.title || item.videoId} — 👨‍🌾 ${item.username}`,
        );
        embed.addFields({ name: '🌱 Next up', value: lines.join('\n').slice(0, 1024) });
      } else {
        embed.addFields({ name: '🌱 Next up', value: 'Silo\'s empty — plant some YouTube links!' });
      }
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await interaction.editReply(`🪨 Couldn't check the silo: ${(error as Error).message}`);
    }
  }

  private async onStatusCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const config = await this.api.config();
      const embed = new EmbedBuilder()
        .setColor(config.enabled && !config.maintenance ? COLORS.green : COLORS.dim)
        .setTitle(`🌾 ${config.botName} — Farm Report`)
        .addFields(
          {
            name: '🚜 State',
            value: config.maintenance
              ? '🛠️ Maintenance (scarecrow on break)'
              : config.enabled
                ? '☀️ Farming'
                : '🌧️ Disabled by the landowner',
            inline: true,
          },
          { name: '📦 Silo', value: `${config.queueCount}/${config.threshold}`, inline: true },
          { name: '📡 Ping', value: `${Math.max(0, Math.round(this.client.ws.ping))} ms`, inline: true },
          { name: '🔧 Gear', value: `v${APP_VERSION}`, inline: true },
        );
      if (config.maintenance) embed.setFooter({ text: config.maintenanceMessage });
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await interaction.editReply(`🪨 Couldn't read the farm report: ${(error as Error).message}`);
    }
  }

  private async onHelpCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const helpText = FARM_MESSAGES.help.replace('{threshold}', String(this.cfg.threshold));
    await interaction.reply({ content: helpText, flags: MessageFlags.Ephemeral });
  }

  private async react(message: Message, emoji: string): Promise<void> {
    try {
      await message.react(emoji);
    } catch {
      /* missing reaction permission is not fatal */
    }
  }

  private async reply(message: Message, content: string): Promise<void> {
    if (!message.channel || !isTextChannel(message.channel)) return;
    try {
      await message.reply({ content: content.slice(0, 1900), allowedMentions: { repliedUser: false } });
    } catch (error) {
      log.warn('could not reply', (error as Error).message);
    }
  }
}

/** Split a comma/space separated channel list from the environment. */
export function envChannelIds(value: string | undefined): string[] {
  return channelList(String(value || ''));
}
