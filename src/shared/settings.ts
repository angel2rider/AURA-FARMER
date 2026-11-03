import type { BotSettings } from './types';

export const DEFAULT_SETTINGS: BotSettings = {
  enabled: true,
  maintenance: false,
  maintenanceMessage: 'Aura Farmer is taking a short break. Try again soon.',
  threshold: 20,
  dispatchSize: 25,
  autoDispatch: true,
  guildId: '',
  channelIds: '',
  logChannelId: '',
  searchEnabled: true,
  playlistExpand: true,
  cooldownSeconds: 0,
  dailyLimit: 0,
  botName: 'Aura Farmer',
  notifyOnDispatch: true,
  notifyOnComplete: true,
  notifyOnFailure: true,
};

const int = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

const bool = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  return fallback;
};

const text = (value: unknown, fallback: string, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : fallback;

export function normalizeSettings(raw: Partial<Record<keyof BotSettings, unknown>> | null | undefined): BotSettings {
  const d = DEFAULT_SETTINGS;
  return {
    enabled: bool(raw?.enabled, d.enabled),
    maintenance: bool(raw?.maintenance, d.maintenance),
    maintenanceMessage: text(raw?.maintenanceMessage, d.maintenanceMessage, 300),
    threshold: int(raw?.threshold, d.threshold, 1, 300),
    dispatchSize: int(raw?.dispatchSize, d.dispatchSize, 1, 25),
    autoDispatch: bool(raw?.autoDispatch, d.autoDispatch),
    guildId: text(raw?.guildId, d.guildId, 32),
    channelIds: text(raw?.channelIds, d.channelIds, 1000),
    logChannelId: text(raw?.logChannelId, d.logChannelId, 32),
    searchEnabled: bool(raw?.searchEnabled, d.searchEnabled),
    playlistExpand: bool(raw?.playlistExpand, d.playlistExpand),
    cooldownSeconds: int(raw?.cooldownSeconds, d.cooldownSeconds, 0, 3600),
    dailyLimit: int(raw?.dailyLimit, d.dailyLimit, 0, 1000),
    botName: text(raw?.botName, d.botName, 80),
    notifyOnDispatch: bool(raw?.notifyOnDispatch, d.notifyOnDispatch),
    notifyOnComplete: bool(raw?.notifyOnComplete, d.notifyOnComplete),
    notifyOnFailure: bool(raw?.notifyOnFailure, d.notifyOnFailure),
  };
}

export function channelList(channelIds: string): string[] {
  return channelIds
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter((v) => /^\d{5,32}$/.test(v));
}

export function settingsToConfig(settings: BotSettings, queueCount: number) {
  return {
    enabled: settings.enabled,
    maintenance: settings.maintenance,
    maintenanceMessage: settings.maintenanceMessage,
    threshold: settings.threshold,
    queueCount,
    guildId: settings.guildId,
    channelIds: channelList(settings.channelIds),
    logChannelId: settings.logChannelId,
    searchEnabled: settings.searchEnabled,
    playlistExpand: settings.playlistExpand,
    cooldownSeconds: settings.cooldownSeconds,
    dailyLimit: settings.dailyLimit,
    botName: settings.botName,
  };
}
