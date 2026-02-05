# Discord Sound Bot

A professional Discord bot that plays sounds from a local folder. Supports queues, volume, loop, shuffle, and more.

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure**
   - Copy `.env.example` to `.env`
   - Add your bot token: `DISCORD_TOKEN=your_token_here`
   - Optional: `PREFIX=!` (default is `!`)

3. **Add sounds**
   - Put `.mp3`, `.wav`, `.ogg`, `.flac`, or `.m4a` files in the `sounds` folder (or upload via the web dashboard)
   - Use the file name (without extension) as the sound name, e.g. `intro.mp3` → `!play intro`
   - The bot **watches the sounds folder** and reloads the library automatically when you add or remove files — no restart or `!reload` needed.

4. **Run**
   ```bash
   npm start
   ```

## Commands

| Command | Description |
|--------|-------------|
| **Voice** | |
| `!join` | Join your voice channel |
| `!leave` | Leave voice and clear queue |
| `!play <name>` | Play a sound (joins if needed) |
| `!add <name>` | Add sound to queue |
| `!stop` | Stop and clear queue |
| `!skip` | Skip current sound |
| `!queue` | Show queue and now playing |
| `!volume [0-200]` | Set or show volume % |
| `!loop` | Toggle loop current track |
| `!loopqueue` | Toggle loop entire queue |
| `!nowplaying` | Show current sound |
| `!shuffle` | Shuffle the queue |
| `!library` | List all available sounds |
| **General** | |
| `!help [command]` | List commands or show help for one |
| `!ping` | Bot latency |
| `!stats` | Servers, users, uptime |
| `!prefix` | Show command prefix |
| `!reload` | Reload sound library from disk (new files without restart) |

Many commands have short aliases (e.g. `!p` for play, `!q` for queue).

## Web dashboard

Run the soundboard dashboard (upload, preview, favorites, copy commands):

```bash
npm run web
```

Then open **http://localhost:3000**. Optional: set `WEB_PORT` in `.env` for a different port.

**Features:** Upload by file or URL (auto-compressed to Opus), preview (play/stop), favorites (stored in browser), sort (A–Z, Z–A, favorites first), delete sounds, copy any command to clipboard, full command list in sidebar. Security: rate limiting, security headers, health check at `/api/health`.

## Deploy on AWS EC2

See **[DEPLOY.md](DEPLOY.md)** for step-by-step instructions to run the bot (and web dashboard) on an Amazon EC2 instance with PM2.

---

## Requirements

- Node.js 18+ (22+ recommended for @discordjs/voice)
- FFmpeg (optional; `ffmpeg-static` is included for basic use)
- Discord bot token with Message Content intent enabled in the Developer Portal
