# Aura Farmer

A Discord front door for [Aura Music](https://aura-music-01g.pages.dev): members
paste YouTube links (or search from Discord), the bot queues them, and once the
queue reaches a configurable threshold the tracks are handed to Aura's existing
`upload-music.yml` download workflow.

Everything is visible and controllable from **Aura Admin → Discord**.

```
Discord  ──►  gateway (VPS)  ──►  Cloudflare Worker + D1  ──►  Aura /api/admin  ──►  GitHub Actions
 users         outbound only        queue, batches,            search / expand /        upload-music.yml
                                    users, audit              dispatch / runs
```

- The gateway opens **no inbound ports**; it connects out to Discord and to the
  Worker. Only a local health endpoint is exposed for Docker.
- The Worker owns the queue, the batch lock, the audit log and all settings.
- Aura's admin panel talks to the Worker through `/api/bot`, so the Worker
  admin token never reaches a browser.
- One batch (≤ 25 tracks) runs at a time. A cron reconciliation matches batches
  against GitHub runs and releases the lock when a run finishes.

## Repository layout

| Path | What it is |
| --- | --- |
| `src/gateway/` | Long-running Discord.js process (commands, message links, announcements, outbox, health server) |
| `src/shared/` | Types, URL parsing and settings normalisation shared by gateway and Worker |
| `worker/src/` | Cloudflare Worker: routes, D1 helpers, submissions, dispatch, admin RPC, Aura client |
| `worker/migrations/` | D1 schema (`0001_init.sql`) |
| `test/` | Node test-runner tests for URL/settings helpers |
| `docs/discord-setup.md` | Create the Discord application, intents, invite link |
| `docs/deployment.md` | Deploy the Worker, the Pages variables, and the VPS gateway |

## Quick start

```bash
npm install
npm run typecheck
npm test
```

The gateway needs a `.env` file; copy the example and fill it in:

```bash
cp .env.example .env
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | ✅ | Bot token from the Developer Portal |
| `DISCORD_CLIENT_ID` | ✅ | Application ID, used to register slash commands |
| `DISCORD_GUILD_ID` | optional | Registers commands instantly in one guild |
| `DISCORD_CHANNEL_ID` | optional | First-run fallback channel list until channels are saved in the admin panel |
| `AURA_BOT_WORKER_URL` | ✅ | Worker base URL, e.g. `https://aura-farmer.<sub>.workers.dev` |
| `AURA_BOT_INGEST_TOKEN` | ✅ | Shared secret for `/v1/bot/*` |
| `OUTBOX_PATH` | optional | Durable outbox when the Worker is unreachable (default `./data/outbox.json`) |
| `STATE_PATH` | optional | Last processed event id (default `./data/state.json`) |
| `HEALTH_PORT` | optional | Health server port (default `9099`) |
| `LOG_LEVEL` | optional | `debug`, `info`, `warn` or `error` |

```bash
npm run dev      # tsx watch, reloads on source changes
npm run build    # bundles dist/gateway.js
npm start        # runs the bundle
```

Without a Discord application the gateway will exit with a clear error; see
[docs/discord-setup.md](docs/discord-setup.md).

## Discord usage

| Trigger | Result |
| --- | --- |
| YouTube / YouTube Music link | Queues the video (multiple links in one message are queued together) |
| Playlist / album link | Expands and queues up to 100 tracks |
| `?query` | Searches YouTube Music in the channel and posts a picker |
| `/find query` | Same search, slash-command form |
| `/playlist url` | Queue a whole playlist |
| `/queue` | Queue depth and the next tracks |
| `/status` | Gateway and queue status |
| `/help` | Usage summary |

Reactions tell the submitter what happened: ✅ queued, ♻️ duplicate, ⛔ banned,
⏳ cooldown/limit, ❌ invalid, 🕓 Worker unreachable (held in the outbox).

Batch announcements (`dispatched`, `completed`, `failed`) go to the log channel,
or to the first submission channel when no log channel is set.

## Admin panel

`admin.html` → **Discord** tab shows:

- gateway status, queue depth vs threshold, active batch, downloaded/failed totals
- **Queue** — search/filter submissions, remove links, retry failed ones, dispatch now
- **Batches** — history with run links and retry for failed tracks
- **Users** — submissions, duplicates, downloads, ban/unban (with reason)
- **Settings** — threshold, tracks per batch, cooldown, daily limit, channels,
  feature toggles, maintenance mode
- **Activity** — every submission, duplicate, batch event and admin action

Settings are polled by the gateway every 30 seconds.

## Security model

| Caller | Credential | Allowed |
| --- | --- | --- |
| Gateway | `BOT_INGEST_TOKEN` | `/v1/bot/*` (submit, config, search, expand, queue preview, heartbeat, events) |
| Aura Pages `/api/bot` | `BOT_ADMIN_TOKEN` | `/v1/admin` (full bot admin RPC) |
| Worker → Aura `/api/admin` | `AURA_SERVICE_TOKEN` | `search`, `expand`, `dispatch`, `runs`, `runJobs`, `libraryIds` only |

- The bot service token cannot read the library, secrets, or any other admin
  action, and it is not a Google/session credential.
- The Worker never stores a Discord token; the gateway never stores an Aura
  admin token.
- Tokens are compared with constant-time comparison where applicable.

## Tests

```bash
npm test          # URL parsing, settings normalisation
npm run typecheck # gateway, shared and Worker
npm run build     # gateway bundle
```

CI runs the same three commands on every push.
