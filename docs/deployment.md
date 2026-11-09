# Deployment

Three pieces:

1. **Cloudflare Worker + D1** — the queue and API (`worker/`)
2. **Aura Pages variables** — lets the admin panel reach the Worker (`/api/bot`)
3. **Discord gateway on the VPS** — the process that talks to Discord (`src/gateway/`)

Deploy them in that order.

## 1. Worker + D1

Requires a Cloudflare account and `wrangler` (installed as a dev dependency).

```bash
cd worker
npx wrangler login
```

### Create the database

```bash
npx wrangler d1 create aura-farmer
```

Copy the `database_id` into `worker/wrangler.jsonc` → `d1_databases[0].database_id`.
Then apply the schema:

```bash
npx wrangler d1 migrations apply aura-farmer --remote
```

### Generate secrets

Generate three random secrets and store them somewhere safe:

```bash
openssl rand -hex 32   # BOT_INGEST_TOKEN (gateway → Worker)
openssl rand -hex 32   # BOT_ADMIN_TOKEN  (Pages → Worker)
openssl rand -hex 32   # AURA_SERVICE_TOKEN (Worker → Aura /api/admin)
```

Set the Worker secrets:

```bash
npx wrangler secret put BOT_INGEST_TOKEN
npx wrangler secret put BOT_ADMIN_TOKEN
npx wrangler secret put AURA_SERVICE_TOKEN
```

### Set the Aura base URL

`worker/wrangler.jsonc` → `vars.AURA_API_URL` must point at the deployed Aura
site (`https://aura-music-01g.pages.dev` for production).

### Deploy

```bash
npx wrangler deploy
```

The Worker deploys with a `*/2 * * * *` cron that reconciles batches against
GitHub runs.

### Smoke test

```bash
curl -s https://aura-farmer.<sub>.workers.dev/health
# {"ok":true,"name":"aura-farmer","version":"1.0.0",...}

curl -s -H "authorization: Bearer $BOT_INGEST_TOKEN" \
  https://aura-farmer.<sub>.workers.dev/v1/bot/config
```

`POST /v1/admin` without a token must return `401`.

## 2. Aura Pages variables

In **Cloudflare Pages → aura-music → Settings → Environment variables →
Production**:

| Variable | Value |
| --- | --- |
| `BOT_WORKER_URL` | `https://aura-farmer.<sub>.workers.dev` |
| `BOT_ADMIN_TOKEN` | same value as the Worker's `BOT_ADMIN_TOKEN` |
| `BOT_SERVICE_TOKEN` | same value as the Worker's `AURA_SERVICE_TOKEN` |

Then redeploy the Pages project (`wrangler pages deploy dist`, or push to
`main`, depending on your setup).

Checks:

- `/api/bot` without a session returns `401`.
- Signed into the admin panel, **Discord** shows a live Worker version even
  while the gateway is offline.
- The Worker's `AURA_SERVICE_TOKEN` test:

```bash
curl -s -X POST https://aura-music-01g.pages.dev/api/admin \
  -H 'content-type: application/json' \
  -d '{"service_token":"'$AURA_SERVICE_TOKEN'","action":"verify"}'
# {"ok":true,"email":"aura-farmer@service"}
```

Any action outside `search`, `expand`, `dispatch`, `runs`, `runJobs`, `libraryIds` returns
`403` for the service token.

## 3. Gateway on the VPS

Target: Ubuntu 24.04, Docker + Compose, outbound access to Discord and
Cloudflare. No inbound port is needed.

```bash
ssh ubuntu@<vps>
git clone https://github.com/angel2rider/AURA-FARMER.git
cd AURA-FARMER
cp .env.example .env
nano .env      # DISCORD_TOKEN, DISCORD_CLIENT_ID, guild/channel ids,
               # AURA_BOT_WORKER_URL, AURA_BOT_INGEST_TOKEN
docker compose up -d --build
docker compose logs -f --tail=100
```

`docker-compose.yml` binds the health endpoint to `127.0.0.1:9099` only and caps
memory at 256 MB. The gateway writes `data/outbox.json` and `data/state.json`
into a host volume, so restarts keep held submissions and the event cursor.

### Verify

```bash
docker compose ps
curl -s http://127.0.0.1:9099/health
```

`"ok": true` plus a non-null `bot` means Discord is connected.

### Update

```bash
cd AURA-FARMER
git pull
docker compose up -d --build
```

Config changes (threshold, channels, bans, announcements) do **not** need a
restart — the admin panel writes them to the Worker and the gateway polls every
30 seconds.

### Logs and data

```bash
docker compose logs -f --tail=200
ls -l data/                 # outbox.json, state.json
```

Docker log rotation is configured in `docker-compose.yml` (10 MB × 3).

### Optional: auto-start on boot

`restart: unless-stopped` already restarts the container after a reboot, as
long as Docker itself is enabled:

```bash
sudo systemctl enable docker
```

## Rotating secrets

Rotate one at a time:

| Secret | Where to change |
| --- | --- |
| `DISCORD_TOKEN` | Developer Portal → Bot → Reset Token → update `.env` → `docker compose up -d` |
| `BOT_INGEST_TOKEN` | Worker secret → gateway `.env` → restart |
| `BOT_ADMIN_TOKEN` | Worker secret and Pages `BOT_ADMIN_TOKEN` → redeploy Pages |
| `AURA_SERVICE_TOKEN` | Worker secret and Pages `BOT_SERVICE_TOKEN` → redeploy Pages |

`BOT_ADMIN_TOKEN` and `AURA_SERVICE_TOKEN` are independent; do not reuse one
value for both.

## Backups

The source of truth is D1. Export it periodically:

```bash
cd worker
npx wrangler d1 export aura-farmer --remote --output ../backup-$(date +%F).sql
```

`data/` on the VPS only holds transient retry state.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Admin Discord tab says “backend is not configured” | `BOT_WORKER_URL` / `BOT_ADMIN_TOKEN` missing on Pages; redeploy |
| `/api/bot` returns 502 | Worker URL wrong or Worker not deployed |
| Worker overview shows `bot.online: false` | Gateway not running, or `BOT_INGEST_TOKEN` mismatch |
| Gateway logs `worker unreachable` | `AURA_BOT_WORKER_URL` wrong, or VPS egress blocked |
| Dispatch does nothing | A batch is already active; wait for the GitHub run to finish, or check the batch error |
| Batch stuck in `dispatched` | No GitHub run id was recorded; the cron marks it failed after 5 minutes, then retry |
| Duplicate tracks stay in a batch | They are marked uploaded/removed automatically from `skippedIds` |
