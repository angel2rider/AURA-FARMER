export const APP_VERSION = '1.0.0';
export const WORKER_NAME = 'aura-farmer';

export type SubmissionStatus =
  | 'queued'
  | 'batched'
  | 'dispatched'
  | 'downloaded'
  | 'uploaded'
  | 'failed'
  | 'removed'
  | 'rejected';

export type BatchStatus =
  | 'dispatching'
  | 'dispatched'
  | 'running'
  | 'completed'
  | 'failed'
  | 'retried';

export type AuditActorType = 'discord' | 'admin' | 'system';

export interface BotSettings {
  enabled: boolean;
  maintenance: boolean;
  maintenanceMessage: string;
  threshold: number;
  dispatchSize: number;
  autoDispatch: boolean;
  guildId: string;
  channelIds: string;
  logChannelId: string;
  searchEnabled: boolean;
  playlistExpand: boolean;
  cooldownSeconds: number;
  dailyLimit: number;
  botName: string;
  notifyOnDispatch: boolean;
  notifyOnComplete: boolean;
  notifyOnFailure: boolean;
}

export interface BotConfig {
  enabled: boolean;
  maintenance: boolean;
  maintenanceMessage: string;
  threshold: number;
  queueCount: number;
  guildId: string;
  channelIds: string[];
  logChannelId: string;
  searchEnabled: boolean;
  playlistExpand: boolean;
  cooldownSeconds: number;
  dailyLimit: number;
  botName: string;
}

export interface DiscordUserInput {
  id: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface SubmissionItem {
  url: string;
  videoId?: string;
  title?: string;
  artist?: string;
  album?: string;
  source?: 'message' | 'search' | 'playlist' | 'command';
  clientKey: string;
}

export interface SubmitPayload {
  guildId?: string;
  channelId: string;
  messageId?: string;
  user: DiscordUserInput;
  items: SubmissionItem[];
}

export type SubmitItemStatus =
  | 'queued'
  | 'duplicate'
  | 'uploaded'
  | 'banned'
  | 'limit'
  | 'cooldown'
  | 'invalid'
  | 'disabled';

export interface SubmitItemResult {
  url: string;
  videoId: string;
  status: SubmitItemStatus;
  title?: string;
  detail?: string;
}

export interface SubmitResponse {
  ok: boolean;
  results: SubmitItemResult[];
  queueCount: number;
  threshold: number;
  message?: string;
  meta?: { queued: number; duplicates: number; rejected: number };
}

export interface QueueItem {
  id: number;
  url: string;
  videoId: string;
  title: string | null;
  artist: string | null;
  username: string;
  discordId: string;
  status: SubmissionStatus;
  createdAt: number;
}

export interface BatchSummary {
  id: number;
  status: BatchStatus;
  trackCount: number;
  runId: number | null;
  runUrl: string | null;
  requestedBy: string;
  error: string | null;
  createdAt: number;
  dispatchedAt: number | null;
  completedAt: number | null;
  doneCount?: number;
  failedCount?: number;
}

export interface UserSummary {
  discordId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  firstSeen: number;
  lastSeen: number;
  banned: boolean;
  banReason: string | null;
  submissions: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  downloaded: number;
}

export interface AuditEntry {
  id: number;
  actorType: AuditActorType;
  actorId: string | null;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  createdAt: number;
}

export interface WorkerEvent {
  id: number;
  action: string;
  details: Record<string, unknown> | null;
  createdAt: number;
}

export interface SearchResult {
  videoId: string;
  title: string;
  sub: string;
  duration: string | null;
  thumbnail: string | null;
  isLive: boolean;
}

export interface HeartbeatPayload {
  version: string;
  botUser: string;
  guildCount: number;
  latencyMs: number;
}

export interface AdminOverview {
  worker: { ok: boolean; now: number; version: string };
  bot: {
    online: boolean;
    lastSeen: number | null;
    version: string | null;
    guildCount: number | null;
    latencyMs: number | null;
    botUser: string | null;
  };
  settings: BotSettings;
  counts: {
    queued: number;
    activeBatches: number;
    downloaded: number;
    uploaded: number;
    failed: number;
    users: number;
    submissions: number;
    today: number;
    removed: number;
  };
  activeBatch: BatchSummary | null;
  recentBatches: BatchSummary[];
  recentAudit: AuditEntry[];
}

export interface AdminQueueResponse {
  items: Array<QueueItem & { batchId: number | null; batchStatus: string | null; error: string | null; channelId: string; source: string }>;
  total: number;
  limit: number;
  offset: number;
}

export interface AdminBatchesResponse {
  items: BatchSummary[];
  total: number;
}

export interface AdminUsersResponse {
  items: UserSummary[];
  total: number;
}

export interface AdminAuditResponse {
  items: AuditEntry[];
  total: number;
}
