const http = require("http");

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`[Bot] Health server listening on ${PORT}`);
});

const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, ActivityType } = require("discord.js");
const config = require("./config");
const { resolveCommand } = require("./commands");
const { getGuildState, reloadAllSounds } = require("./utils/voiceManager");

// Ensure sounds folder exists
if (!fs.existsSync(config.soundFolder)) {
  fs.mkdirSync(config.soundFolder, { recursive: true });
  console.log("[Bot] Created sounds folder at:", config.soundFolder);
} else {
  const files = fs.readdirSync(config.soundFolder).filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return [".mp3", ".wav", ".ogg", ".flac", ".m4a"].includes(ext) && fs.statSync(path.join(config.soundFolder, f)).isFile();
  });
  console.log("[Bot] Loaded", files.length, "sound(s):", files.map((f) => path.parse(f).name).join(", ") || "(none)");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once("clientReady", () => {
  console.log("[Bot] Logged in as", client.user.tag);
  console.log("[Bot] Prefix:", config.prefix, "| Servers:", client.guilds.cache.size);
  client.user.setActivity(`${config.prefix}help`, { type: ActivityType.Listening });

  // Auto-reload sound library when files are added/removed in sounds folder
  let reloadTimeout = null;
  const SOUND_EXTENSIONS = [".mp3", ".wav", ".ogg", ".flac", ".m4a"];
  const isSoundFile = (f) => SOUND_EXTENSIONS.includes(path.extname(f).toLowerCase());
  try {
    fs.watch(config.soundFolder, (eventType, filename) => {
      if (!filename || !isSoundFile(filename)) return;
      if (reloadTimeout) clearTimeout(reloadTimeout);
      reloadTimeout = setTimeout(() => {
        reloadTimeout = null;
        reloadAllSounds();
        const firstGuild = client.guilds.cache.first();
        const count = firstGuild ? getGuildState(firstGuild.id).getAllSounds().length : 0;
        console.log("[Bot] Sound library updated automatically." + (firstGuild ? " " + count + " sound(s) available." : ""));
      }, 500);
    });
    console.log("[Bot] Watching sounds folder for changes (no restart needed).");
  } catch (err) {
    console.warn("[Bot] Could not watch sounds folder:", err.message);
  }
});

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  const prefix = config.prefix;
  if (!msg.content.startsWith(prefix)) return;
  const args = msg.content.slice(prefix.length).trim().split(/\s+/);
  const commandName = args.shift()?.toLowerCase();
  if (!commandName) return;

  const command = resolveCommand(commandName);
  if (!command) {
    return msg.reply(`Unknown command. Use \`${prefix}help\` for the list.`).catch(() => {});
  }

  try {
    await command.execute(msg, args);
  } catch (err) {
    console.error("[Bot] Command error:", command.name, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
    const msgText = err?.message ? `Something went wrong: ${err.message}` : "Something went wrong running that command.";
    msg.reply(msgText).catch(() => {});
  }
});

client.on("voiceStateUpdate", (oldState, newState) => {
  if (newState.id !== client.user.id) return;
  if (newState.channelId) return;
  const state = getGuildState(newState.guild.id);
  state.leave();
});

if (!config.token) {
  console.error("[Bot] No DISCORD_TOKEN set. Create a .env file with DISCORD_TOKEN=your_token");
  process.exit(1);
}

client.login(config.token).catch((err) => {
  console.error("[Bot] Login failed:", err.message);
  process.exit(1);
});

function shutdown(signal) {
  console.log("[Bot] Shutting down (" + signal + ")…");
  client.destroy();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
