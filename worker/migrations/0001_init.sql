-- Aura Farmer worker schema. All timestamps are Unix milliseconds.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  discord_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  banned INTEGER NOT NULL DEFAULT 0,
  ban_reason TEXT,
  submissions INTEGER NOT NULL DEFAULT 0,
  accepted INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  downloaded INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'dispatching',
  track_count INTEGER NOT NULL DEFAULT 0,
  run_id INTEGER,
  run_url TEXT,
  requested_by TEXT NOT NULL DEFAULT 'auto',
  error TEXT,
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  source_key TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  username TEXT NOT NULL,
  url TEXT NOT NULL,
  video_id TEXT NOT NULL,
  title TEXT,
  artist TEXT,
  album TEXT,
  source TEXT NOT NULL DEFAULT 'message',
  status TEXT NOT NULL DEFAULT 'queued',
  batch_id INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES batches(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_source_key ON submissions(source_key);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_submissions_video ON submissions(video_id, status);
CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(discord_id, created_at);
CREATE INDEX IF NOT EXISTS idx_submissions_batch ON submissions(batch_id, status);
CREATE INDEX IF NOT EXISTS idx_batches_status ON batches(status, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at DESC);

CREATE TABLE IF NOT EXISTS bot_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_seen INTEGER NOT NULL,
  version TEXT,
  guild_count INTEGER,
  latency_ms INTEGER,
  bot_user TEXT
);

INSERT OR IGNORE INTO bot_status (id, last_seen, version, guild_count, latency_ms, bot_user)
VALUES (1, 0, NULL, NULL, NULL, NULL);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('enabled', 'true', 0),
  ('maintenance', 'false', 0),
  ('maintenanceMessage', '"Aura Farmer is taking a short break. Try again soon."', 0),
  ('threshold', '20', 0),
  ('dispatchSize', '25', 0),
  ('autoDispatch', 'true', 0),
  ('guildId', '""', 0),
  ('channelIds', '""', 0),
  ('logChannelId', '""', 0),
  ('searchEnabled', 'true', 0),
  ('playlistExpand', 'true', 0),
  ('cooldownSeconds', '0', 0),
  ('dailyLimit', '0', 0),
  ('botName', '"Aura Farmer"', 0),
  ('notifyOnDispatch', 'true', 0),
  ('notifyOnComplete', 'true', 0),
  ('notifyOnFailure', 'true', 0),
  ('dispatchLock', '0', 0);
