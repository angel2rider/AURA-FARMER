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

const REACTIONS = {
  queued: '✅',
  duplicate: '♻️',
  banned: '⛔',
  blocked: '⏳',
  invalid: '❌',
  offline: '🕓',
} as const;

function defaultConfig(): BotConfig {
  return {
    enabled: false,
    maintenance: false,
    maintenanceMessage: 'Aura Farmer is taking a short break.',
    threshold: 20,
    queueCount: 0,
    guildId: '',
    channelIds: [],
    logChannelId: '',
    searchEnabled: true,
    playlistExpand: true,
    cooldownSeconds: 0,
    dailyLimit: 0,
    botName: 'Aura Farmer',
  };
}

function isTextChannel(channel: unknown): channel is TextBasedChannel & { send: (options: any) => Promise<any> } {
  return Boolean(channel && typeof (channel as any).send === 'function');
}

function resultEmoji(results: SubmitItemResult[]): string {
  const statuses = new Set(results.map((result) => result.status));
  if (statuses.has('banned')) return REACTIONS.banned;
  if (statuses.has('cooldown') || statuses.has('limit')) return REACTIONS.blocked;
  if (statuses.has('queued')) return REACTIONS.queued;
  if (statuses.has('duplicate')) return REACTIONS.duplicate;
  return REACTIONS.invalid;
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
    }, 120_000);
    void this.sendHeartbeat();
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
            name: `${this.cfg.queueCount}/${this.cfg.threshold} queued · /help`,
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
        .setTitle(`Batch #${details.batchId ?? '?'} handed to the downloader`)
        .setDescription(
          `${details.dispatched ?? details.count ?? 0} track(s) sent to Aura's upload workflow.`,
        )
        .addFields(
          { name: 'Requested by', value: String(details.requestedBy || 'auto'), inline: true },
          { name: 'Waiting in queue', value: String(details.remaining ?? '—'), inline: true },
        );
      if (details.runUrl) embed.setURL(String(details.runUrl));
    } else if (event.action === 'batch.completed') {
      embed = new EmbedBuilder()
        .setColor(COLORS.green)
        .setTitle(`Batch #${details.batchId ?? '?'} finished`)
        .setDescription(
          `${details.downloaded ?? details.trackCount ?? 0} track(s) downloaded into the Aura library.`,
        );
      if (details.runUrl) embed.setURL(String(details.runUrl));
    } else if (event.action === 'batch.failed') {
      embed = new EmbedBuilder()
        .setColor(COLORS.red)
        .setTitle(`Batch #${details.batchId ?? '?'} failed`)
        .setDescription(String(details.error || 'The upload workflow failed.').slice(0, 1900));
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
      await this.react(message, resultEmoji(response.results));
      const queued = response.results.filter((result) => result.status === 'queued').length;
      if (queued === 0 && response.message) {
        await this.reply(message, response.message);
      } else if (response.queueCount >= response.threshold && queued > 0) {
        await this.reply(
          message,
          `Queued **${queued}** · **${response.queueCount}/${response.threshold}** — dispatch starts automatically.`,
        );
      }
    } catch (error) {
      if (error instanceof WorkerApiError && error.status === 0) {
        await this.outbox.add(payload);
        await this.react(message, REACTIONS.offline);
        log.warn('worker unreachable — submission held in outbox');
        return;
      }
      await this.react(message, REACTIONS.invalid);
      log.error('submission failed', (error as Error).message);
    }
  }

  private async submitPlaylistMessage(message: Message, url: string): Promise<void> {
    if (!message.channel || !isTextChannel(message.channel)) return;
    if (!this.cfg.playlistExpand) {
      await this.reply(message, 'Playlist expansion is disabled right now — paste individual tracks instead.');
      return;
    }
    if (!isPlaylistUrl(url)) {
      await this.react(message, REACTIONS.invalid);
      return;
    }
    await this.react(message, '⏳');
    let expanded: ExpandResult;
    try {
      expanded = await this.api.expand(url);
    } catch (error) {
      await this.react(message, REACTIONS.invalid);
      await this.reply(message, `Could not expand that playlist: ${(error as Error).message}`);
      return;
    }
    if (!expanded.tracks.length) {
      await this.reply(message, 'That playlist has no tracks I can queue.');
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
              displayName:
                message.member?.displayName || message.author.globalName || message.author.username,
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

    await this.react(message, queued ? REACTIONS.queued : REACTIONS.duplicate);
    await this.reply(
      message,
      `**${expanded.title}** — queued **${queued}**${duplicates ? `, skipped ${duplicates} already queued` : ''}. Queue: **${lastCount}/${lastThreshold}**.`,
    );
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
        await interaction.editReply(`No music found for **${query}**.`);
        return;
      }
      const id = this.cacheSearch(results, interaction.user.id);
      await interaction.editReply({
        content: `Results for **${query}** — choose up to 5 tracks to queue.`,
        components: [this.searchRow(id, results)],
      });
    } catch (error) {
      await interaction.editReply(`Search failed: ${(error as Error).message}`);
    }
  }

  private async onPick(interaction: StringSelectMenuInteraction): Promise<void> {
    const cacheId = interaction.customId.slice('aura:pick:'.length);
    const entry = this.searchCache.get(cacheId);
    if (!entry || Date.now() - entry.at > SEARCH_TTL_MS) {
      await interaction.reply({
        content: 'That search expired — run `/find` again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (entry.userId !== interaction.user.id) {
      await interaction.reply({
        content: 'That menu belongs to another user — run `/find` yourself.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const picked = entry.results.filter((result) => interaction.values.includes(result.videoId));
    if (!picked.length) {
      await interaction.reply({ content: 'Those results expired — run `/find` again.', flags: MessageFlags.Ephemeral });
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
      await interaction.editReply({
        content: `Queued **${queued}/${picked.length}** · queue **${response.queueCount}/${response.threshold}**${summarizeResults(response.results) ? ` (${summarizeResults(response.results)})` : ''}.`,
      });
    } catch (error) {
      await interaction.editReply(`Could not queue that: ${(error as Error).message}`);
    }
  }

  private async onPlaylistCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.cfg.playlistExpand) {
      await interaction.reply({
        content: 'Playlist expansion is disabled right now.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!(await this.requireCommandChannel(interaction))) return;
    const url = interaction.options.getString('url', true).trim();
    if (!isPlaylistUrl(url)) {
      await interaction.reply({
        content: 'That is not a YouTube playlist link.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let expanded: ExpandResult;
    try {
      expanded = await this.api.expand(url);
    } catch (error) {
      await interaction.editReply(`Could not expand that playlist: ${(error as Error).message}`);
      return;
    }
    if (!expanded.tracks.length) {
      await interaction.editReply('That playlist has no tracks I can queue.');
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
        await interaction.editReply(`Playlist queueing stopped: ${(error as Error).message}`);
        return;
      }
    }
    await interaction.editReply(
      `**${expanded.title}** — queued **${queued}**${duplicate ? `, skipped ${duplicate} already queued` : ''}. Queue: **${count}/${threshold}**.`,
    );
  }

  private async onQueueCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const data = await this.api.queue(10);
      const embed = new EmbedBuilder()
        .setColor(COLORS.gold)
        .setTitle('Aura Farmer queue')
        .setDescription(`**${data.count}/${data.threshold}** tracks waiting for the next batch.`);
      if (data.items.length) {
        const lines = data.items.map(
          (item, index) =>
            `**${index + 1}.** ${item.title || item.videoId} — ${item.username}`,
        );
        embed.addFields({ name: 'Next up', value: lines.join('\n').slice(0, 1024) });
      } else {
        embed.addFields({ name: 'Next up', value: 'Nothing queued yet — paste a YouTube link.' });
      }
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await interaction.editReply(`Could not read the queue: ${(error as Error).message}`);
    }
  }

  private async onStatusCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const config = await this.api.config();
      const embed = new EmbedBuilder()
        .setColor(config.enabled && !config.maintenance ? COLORS.green : COLORS.dim)
        .setTitle(`${config.botName} status`)
        .addFields(
          {
            name: 'State',
            value: config.maintenance
              ? 'Maintenance'
              : config.enabled
                ? 'Online'
                : 'Disabled by an admin',
            inline: true,
          },
          { name: 'Queue', value: `${config.queueCount}/${config.threshold}`, inline: true },
          { name: 'Latency', value: `${Math.max(0, Math.round(this.client.ws.ping))} ms`, inline: true },
          { name: 'Gateway', value: `v${APP_VERSION}`, inline: true },
        );
      if (config.maintenance) embed.setFooter({ text: config.maintenanceMessage });
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await interaction.editReply(`Could not read status: ${(error as Error).message}`);
    }
  }

  private async onHelpCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const embed = new EmbedBuilder()
      .setColor(COLORS.gold)
      .setTitle('Aura Farmer')
      .setDescription(
        'Paste a YouTube or YouTube Music link in the submission channel and it joins the next download batch.',
      )
      .addFields(
        { name: '/find query', value: 'Search YouTube Music and queue a track.' },
        { name: '/playlist url', value: 'Queue a whole playlist (up to 100 tracks).' },
        { name: '/queue', value: 'See what is waiting for the next batch.' },
        { name: '/status', value: 'Check whether the bot is online.' },
      )
      .setFooter({ text: `Threshold: ${this.cfg.threshold} tracks · batches up to 25` });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
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
