# Discord setup (beginner friendly)

This walks through creating the Discord application from scratch. It takes
about ten minutes. You need the **Manage Server** permission on the Discord
server where the bot will live.

## 1. Create the application

1. Open <https://discord.com/developers/applications>.
2. **New Application** → name it `Aura Farmer` → accept the terms → **Create**.
3. On **General Information**, copy the **Application ID**. This is
   `DISCORD_CLIENT_ID`.

## 2. Create the bot user

1. Left sidebar → **Bot**.
2. The bot is created automatically with the application; click **Reset Token**
   → **Copy**. This is `DISCORD_TOKEN`.
   - Treat it like a password. If it ever leaks, reset it again immediately.
   - Never paste it into a chat, a commit, or the admin panel.
3. Scroll to **Privileged Gateway Intents** and enable:
   - **Message Content Intent** — required to read links people paste.
   - **Server Members Intent** is *not* required.
4. **Save Changes**.

If `Message Content Intent` stays off, the gateway starts and then disconnects
with `Used disallowed intents`. That is the fix.

## 3. Invite the bot

1. Left sidebar → **OAuth2** → **URL Generator**.
2. Scopes: `bot` and `applications.commands`.
3. Bot permissions:
   - View Channels
   - Send Messages
   - Embed Links
   - Read Message History
   - Add Reactions
4. Copy the generated URL, open it, pick your server, **Authorize**.

The bot now appears offline until the gateway is running.

## 4. Collect the IDs

Discord IDs are long numbers. To copy them:

1. Discord → **User Settings** → **Advanced** → enable **Developer Mode**.
2. Right-click the server icon → **Copy Server ID** (`DISCORD_GUILD_ID`).
3. Right-click the channel where people will submit music →
   **Copy Channel ID** (`DISCORD_CHANNEL_ID`).
4. Optional: repeat for a channel where batch announcements should go
   (`logChannelId` in the admin panel).

Using the guild ID when starting the gateway registers slash commands
instantly. Without it, commands are global and can take up to an hour to
appear.

## 5. Configure the bot

You can set everything from **Aura Admin → Discord → Settings**:

| Field | Suggested | Notes |
| --- | --- | --- |
| Bot enabled | on | Master switch; the gateway goes idle when off |
| Maintenance mode | off | Blocks submissions with the maintenance message |
| Dispatch threshold | 20 | Queue length that triggers a hand-off (1–300) |
| Tracks per batch | 25 | GitHub runs accept 25 URLs per run (1–25) |
| Cooldown | 0 | Seconds between submissions per user |
| Daily limit | 0 | Accepted links per user per day; 0 = unlimited |
| Guild ID | your server | Restricts the bot to one server |
| Submission channels | one or more channel IDs | Comma-separated; the bot ignores everything else |
| Log channel ID | optional | Batch announcements; falls back to the first submission channel |
| Allow search | on | Enables `/find` and `?query` |
| Expand playlists | on | Allows playlist/album links |

Environment variables (`DISCORD_GUILD_ID`, `DISCORD_CHANNEL_ID`) only act as a
fallback until the admin panel has values; the panel wins.

## 6. Start the gateway

Locally:

```bash
cp .env.example .env
# fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, AURA_BOT_WORKER_URL,
# AURA_BOT_INGEST_TOKEN
npm run dev
```

You should see:

```
INFO logged in as Aura Farmer#1234
INFO registered slash commands in guild 123456789012345678
INFO listening in 123456789012345678
```

Then in Discord:

- paste a YouTube link in the submission channel → ✅ reaction
- run `/help` → the help embed appears
- run `/queue` → queue depth

For the permanent VPS deployment, see [deployment.md](deployment.md).

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `An invalid token was provided` | You copied the client secret instead of the bot token, or reset the token after copying it |
| `Used disallowed intents` | Enable **Message Content Intent** in the Bot settings |
| Bot online but ignores links | Channel ID not in **Submission channels**, or the bot lacks **Read Message History** / **View Channels** |
| Slash commands missing | Commands were registered globally; wait up to an hour, or set `DISCORD_GUILD_ID` and restart |
| 🕓 reaction only | The Worker is unreachable; the submission is retried from the outbox |
| ❌ reaction on a valid link | The video is private, age-restricted, or not a YouTube URL the bot recognises |
| “No submission channel configured” in the log | Set channel IDs in **Discord → Settings** |
