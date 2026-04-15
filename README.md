# VERA Ticket Bot

Receives bug reports from VERA via HTTP and manages them as Discord forum threads.

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
Copy `.env.example` to `.env` and fill in the values:
```bash
cp .env.example .env
```

| Variable | How to get it |
|---|---|
| `DISCORD_TOKEN` | Discord Developer Portal → your app → Bot → Token |
| `GUILD_ID` | Right-click your server → Copy Server ID (needs Developer Mode on) |
| `BUG_REPORT_CHANNEL_ID` | Right-click the forum channel → Copy Channel ID |
| `VERA_SECRET` | Any long random string — paste the same value into VERA's config |
| `HTTP_PORT` | Port for the HTTP server (default 8080) |

### 3. Set up the forum channel
1. Create a **Forum** channel in your server (not a regular text channel)
2. The bot will automatically create **Open** and **Closed** tags the first time they're needed
3. Give the bot the **Manage Channels** permission so it can create/edit tags and threads

### 4. Bot permissions
The bot needs these permissions:
- View Channels
- Send Messages
- Create Public/Private Threads
- Manage Threads
- Manage Channels (for creating forum tags)

### 5. Run the bot
```bash
node bot.js
```

Or with pm2 for always-on:
```bash
pm2 start bot.js --name vera-bot
pm2 save
```

## VERA integration

VERA sends a POST request to the bot:

```
POST http://your-vps-ip:8080/report
X-VERA-Token: your-secret-here
Content-Type: application/json

{
  "version": "0.88.0",
  "description": "Something broke",
  "log_snippet": "last 50 lines of vera.log",
  "discord_username": "optional"
}
```

Response:
```json
{ "ticket_id": 1, "thread_url": "https://discord.com/channels/..." }
```

## Slash commands

Both commands only work inside a ticket thread.

| Command | Description |
|---|---|
| `/close [reason]` | Marks ticket resolved, renames thread, swaps tag to Closed, locks and archives |
| `/note <text>` | Posts a staff note embed in the thread |
