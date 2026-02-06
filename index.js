const fs = require("fs");
const path = require("path");
const http = require("http");
const { Client, GatewayIntentBits, ActivityType, ChannelType } = require("discord.js");
const config = require("./config");
const { resolveCommand } = require("./commands");
const { getGuildState, reloadAllSounds } = require("./utils/voiceManager");

const BOT_API_PORT = parseInt(process.env.BOT_API_PORT || "3001", 10);
const CHANNEL_TYPE_NAMES = {
  [ChannelType.GuildText]: "Text",
  [ChannelType.GuildVoice]: "Voice",
  [ChannelType.GuildCategory]: "Category",
  [ChannelType.GuildAnnouncement]: "Announcement",
  [ChannelType.GuildStageVoice]: "Stage",
  [ChannelType.PublicThread]: "Thread",
  [ChannelType.PrivateThread]: "Private thread",
};

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

  // Internal HTTP API for dashboard: guilds, channels, members, create channel (localhost only)
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    let pathname = (req.url || "/").split("?")[0];
    try {
      pathname = decodeURIComponent(pathname);
    } catch (_) {}
    const matchGuilds = pathname === "/guilds" || pathname === "/guilds/";
    const isCreateDefault = req.method === "POST" && (pathname.endsWith("/channels/create-default") || pathname.endsWith("/channels/create-default/"));
    const matchCreateDefault = isCreateDefault ? /^\/guilds\/([^/]+)\/channels\/create-default\/?$/.exec(pathname) : null;
    const matchChannels = !isCreateDefault ? /^\/guilds\/([^/]+)\/channels\/?$/.exec(pathname) : null;
    const matchChannelSingle = /^\/guilds\/([^/]+)\/channels\/([^/]+)\/?$/.exec(pathname);
    const matchRolesReorder = req.method === "PUT" && /^\/guilds\/([^/]+)\/roles\/reorder\/?$/.exec(pathname);
    const matchRoleSingle = /^\/guilds\/([^/]+)\/roles\/([^/]+)\/?$/.exec(pathname);
    const matchRoles = /^\/guilds\/([^/]+)\/roles\/?$/.exec(pathname);
    const matchMemberRole = /^\/guilds\/([^/]+)\/members\/([^/]+)\/roles\/([^/]+)\/?$/.exec(pathname);
    const matchMembers = /^\/guilds\/([^/]+)\/members\/?$/.exec(pathname);

    function permErr(err) {
      const code = err.code ?? err.body?.code;
      if (code === 50013) {
        return "Permission denied. (1) Re-invite the bot with Manage Channels and Manage Roles. (2) In Server Settings → Roles, drag the bot’s role above any role or channel you want to edit or delete.";
      }
      return err.message || "Operation failed";
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const matchReload = pathname === "/reload" || pathname === "/reload/";
    if (matchReload && req.method === "POST") {
      try {
        reloadAllSounds();
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, message: "Sound library reloaded." }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ ok: false, error: err.message || "Reload failed" }));
      }
    }

    try {
      if (matchCreateDefault && req.method === "POST") {
        const guildId = matchCreateDefault[1];
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
          res.writeHead(404);
          return res.end(JSON.stringify({ ok: false, error: "Guild not found" }));
        }
        try {
        const created = [];
        const rootChannels = [
          { emoji: "👋", name: "welcome" },
          { emoji: "📣", name: "rules" },
          { emoji: "🎉", name: "events" },
          { emoji: "📢", name: "game-news" },
          { emoji: "🔔", name: "announcements" },
        ];
        const chatsChannels = [
          { emoji: "📜", name: "public-chat" },
          { emoji: "🎬", name: "your-clips" },
          { emoji: "🎮", name: "chat-game" },
          { emoji: "😂", name: "memes" },
          { emoji: "⬆️", name: "level-ups" },
          { emoji: "🤖", name: "bot-commands" },
          { emoji: "🕋", name: "اذكار" },
        ];
        const delay = (ms) => new Promise((r) => setTimeout(r, ms));
        const chatsCat = await guild.channels.create({ name: "CHATS", type: ChannelType.GuildCategory });
        created.push({ name: chatsCat.name, type: "Category" });
        await delay(300);
        for (const { emoji, name } of rootChannels) {
          const ch = await guild.channels.create({ name: emoji + " " + name, type: ChannelType.GuildText });
          created.push({ name: ch.name, type: "Text" });
          await delay(250);
        }
        for (const { emoji, name } of chatsChannels) {
          const ch = await guild.channels.create({ name: emoji + " " + name, type: ChannelType.GuildText, parent: chatsCat.id });
          created.push({ name: ch.name, type: "Text" });
          await delay(250);
        }
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, created: created.length, channels: created }));
        } catch (err) {
          console.error("[Bot] create-default error:", err);
          const code = err.code ?? err.body?.code;
          const msg = code === 50013
            ? "Permission denied. Re-invite the bot with Manage Channels, and in Server Settings → Roles drag the bot’s role above others."
            : (err.message || "Failed to create channels");
          res.writeHead(500);
          return res.end(JSON.stringify({ ok: false, error: msg }));
        }
      }

      if (matchChannels && req.method === "POST") {
        const guildId = matchChannels[1];
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
          res.writeHead(404);
          return res.end(JSON.stringify({ ok: false, error: "Guild not found" }));
        }
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
        }
        const name = (body.name || "").trim().slice(0, 100);
        const emoji = (body.emoji || "").trim().slice(0, 20);
        const fullName = emoji ? emoji + " " + name : name;
        if (!fullName) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "Channel name is required" }));
        }
        const typeStr = (body.type || "text").toLowerCase();
        const typeMap = { text: ChannelType.GuildText, voice: ChannelType.GuildVoice, category: ChannelType.GuildCategory, announcement: ChannelType.GuildAnnouncement };
        const type = typeMap[typeStr] || ChannelType.GuildText;
        const parentId = body.parentId || null;
        try {
          const channel = await guild.channels.create({
            name: fullName,
            type,
            parent: parentId || undefined,
          });
          res.writeHead(200);
          return res.end(JSON.stringify({
            ok: true,
            channel: { id: channel.id, name: channel.name, type: channel.type, typeName: CHANNEL_TYPE_NAMES[channel.type] || "Other", parentId: channel.parentId },
          }));
        } catch (err) {
          res.writeHead(500);
          return res.end(JSON.stringify({ ok: false, error: permErr(err) }));
        }
      }

      if (matchChannelSingle && (req.method === "PATCH" || req.method === "DELETE")) {
        const [, guildId, channelId] = matchChannelSingle;
        const guild = client.guilds.cache.get(guildId);
        const channel = guild?.channels.cache.get(channelId);
        if (!guild || !channel) {
          res.writeHead(404);
          return res.end(JSON.stringify({ ok: false, error: "Guild or channel not found" }));
        }
        try {
          if (req.method === "DELETE") {
            await channel.delete();
            res.writeHead(200);
            return res.end(JSON.stringify({ ok: true, deleted: channelId }));
          }
          let body = {};
          try { body = JSON.parse(await readBody(req)); } catch (_) {}
          const opts = {};
          if (body.name != null) opts.name = String(body.name).trim().slice(0, 100);
          if (body.parentId != null) opts.parent = body.parentId || null;
          if (typeof body.position === "number") opts.position = body.position;
          if (body.topic !== undefined) opts.topic = body.topic == null || body.topic === "" ? null : String(body.topic).slice(0, 1024);
          if (body.nsfw !== undefined) opts.nsfw = Boolean(body.nsfw);
          if (typeof body.rateLimitPerUser === "number" && body.rateLimitPerUser >= 0) opts.rateLimitPerUser = Math.min(21600, body.rateLimitPerUser);
          if (typeof body.bitrate === "number" && body.bitrate >= 8000) opts.bitrate = Math.min(384000, body.bitrate);
          if (typeof body.userLimit === "number" && body.userLimit >= 0) opts.userLimit = Math.min(99, body.userLimit);
          const updated = await channel.edit(opts);
          const out = { id: updated.id, name: updated.name, type: updated.type, typeName: CHANNEL_TYPE_NAMES[updated.type] || "Other", parentId: updated.parentId, position: updated.position };
          if (updated.topic != null) out.topic = updated.topic;
          if (updated.nsfw != null) out.nsfw = updated.nsfw;
          if (updated.rateLimitPerUser != null) out.rateLimitPerUser = updated.rateLimitPerUser;
          if (updated.bitrate != null) out.bitrate = updated.bitrate;
          if (updated.userLimit != null) out.userLimit = updated.userLimit;
          res.writeHead(200);
          return res.end(JSON.stringify({ ok: true, channel: out }));
        } catch (err) {
          res.writeHead(500);
          return res.end(JSON.stringify({ ok: false, error: permErr(err) }));
        }
      }

      if (matchRolesReorder) {
        const [, guildId] = matchRolesReorder;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
          res.writeHead(404);
          return res.end(JSON.stringify({ ok: false, error: "Guild not found" }));
        }
        let body;
        try { body = JSON.parse(await readBody(req)); } catch (_) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        }
        const positions = Array.isArray(body.positions) ? body.positions : [];
        if (!positions.length) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "positions array required" }));
        }
        try {
          const rolePositions = positions.map((p) => ({ role: p.id, position: typeof p.position === "number" ? p.position : 0 }));
          await guild.roles.setPositions(rolePositions);
          const roles = guild.roles.cache.filter((r) => r.name !== "@everyone").sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name, color: r.hexColor || null, position: r.position }));
          res.writeHead(200);
          return res.end(JSON.stringify({ ok: true, roles }));
        } catch (err) {
          res.writeHead(500);
          return res.end(JSON.stringify({ ok: false, error: permErr(err) }));
        }
      }

      if (matchRoleSingle && (req.method === "PATCH" || req.method === "DELETE")) {
        const [, guildId, roleId] = matchRoleSingle;
        const guild = client.guilds.cache.get(guildId);
        const role = guild?.roles.cache.get(roleId);
        if (!guild || !role) {
          res.writeHead(404);
          return res.end(JSON.stringify({ ok: false, error: "Guild or role not found" }));
        }
        if (role.name === "@everyone") {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "Cannot edit @everyone" }));
        }
        try {
          if (req.method === "DELETE") {
            await role.delete();
            res.writeHead(200);
            return res.end(JSON.stringify({ ok: true, deleted: roleId }));
          }
          let body = {};
          try { body = JSON.parse(await readBody(req)); } catch (_) {}
          const opts = {};
          if (body.name != null) opts.name = String(body.name).trim().slice(0, 100);
          if (body.color != null) opts.color = body.color;
          if (typeof body.position === "number") opts.position = body.position;
          const updated = await role.edit(opts);
          res.writeHead(200);
          return res.end(JSON.stringify({
            ok: true,
            role: { id: updated.id, name: updated.name, color: updated.hexColor || null, position: updated.position },
          }));
        } catch (err) {
          res.writeHead(500);
          return res.end(JSON.stringify({ ok: false, error: permErr(err) }));
        }
      }

      if (matchRoles && req.method === "POST") {
        const guildId = matchRoles[1];
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
          res.writeHead(404);
          return res.end(JSON.stringify({ ok: false, error: "Guild not found" }));
        }
        let body = {};
        try { body = JSON.parse(await readBody(req)); } catch (_) {}
        const name = (body.name || "new role").trim().slice(0, 100);
        try {
          const role = await guild.roles.create({ name, color: body.color ?? 0 });
          res.writeHead(200);
          return res.end(JSON.stringify({
            ok: true,
            role: { id: role.id, name: role.name, color: role.hexColor || null, position: role.position },
          }));
        } catch (err) {
          res.writeHead(500);
          return res.end(JSON.stringify({ ok: false, error: permErr(err) }));
        }
      }

      if (matchMemberRole && (req.method === "PUT" || req.method === "DELETE")) {
        const [, guildId, userId, roleId] = matchMemberRole;
        const guild = client.guilds.cache.get(guildId);
        const role = guild?.roles.cache.get(roleId);
        if (!guild || !role) {
          res.writeHead(404);
          return res.end(JSON.stringify({ ok: false, error: "Guild or role not found" }));
        }
        let member;
        try { member = await guild.members.fetch(userId); } catch (_) {
          res.writeHead(404);
          return res.end(JSON.stringify({ ok: false, error: "Member not found" }));
        }
        try {
          if (req.method === "PUT") {
            await member.roles.add(roleId);
            const roles = member.roles.cache.filter((r) => r.name !== "@everyone").map((r) => ({ id: r.id, name: r.name }));
            res.writeHead(200);
            return res.end(JSON.stringify({ ok: true, roles }));
          } else {
            await member.roles.remove(roleId);
            const roles = member.roles.cache.filter((r) => r.name !== "@everyone").map((r) => ({ id: r.id, name: r.name }));
            res.writeHead(200);
            return res.end(JSON.stringify({ ok: true, roles }));
          }
        } catch (err) {
          res.writeHead(500);
          return res.end(JSON.stringify({ ok: false, error: permErr(err) }));
        }
      }

      if (req.method !== "GET") {
        res.writeHead(405);
        return res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
      }

      if (matchGuilds) {
        const guilds = client.guilds.cache.map((g) => ({
          id: g.id,
          name: g.name,
          icon: g.iconURL({ size: 64 }),
          memberCount: g.memberCount,
          channelCount: g.channels.cache.size,
        }));
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, guilds }));
      }
      if (matchChannels) {
        const guildId = matchChannels[1];
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
          res.writeHead(404);
          return res.end(JSON.stringify({ ok: false, error: "Guild not found" }));
        }
        const channels = guild.channels.cache
          .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
          .map((c) => {
            const out = {
              id: c.id,
              name: c.name,
              type: c.type,
              typeName: CHANNEL_TYPE_NAMES[c.type] || "Other",
              parentId: c.parentId,
              position: c.position,
            };
            if (c.topic != null) out.topic = c.topic;
            if (c.nsfw != null) out.nsfw = c.nsfw;
            if (c.rateLimitPerUser != null) out.rateLimitPerUser = c.rateLimitPerUser;
            if (c.bitrate != null) out.bitrate = c.bitrate;
            if (c.userLimit != null) out.userLimit = c.userLimit;
            return out;
          });
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, channels }));
      }
      if (matchRoles) {
        const guildId = matchRoles[1];
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
          res.writeHead(404);
          return res.end(JSON.stringify({ ok: false, error: "Guild not found" }));
        }
        const roles = guild.roles.cache
          .filter((r) => r.name !== "@everyone")
          .sort((a, b) => b.position - a.position)
          .map((r) => ({ id: r.id, name: r.name, color: r.hexColor || null, position: r.position }));
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, roles }));
      }
      if (matchMembers) {
        const guildId = matchMembers[1];
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
          res.writeHead(404);
          return res.end(JSON.stringify({ ok: false, error: "Guild not found" }));
        }
        const members = guild.members.cache.map((m) => ({
          id: m.id,
          username: m.user.username,
          tag: m.user.tag,
          displayName: m.displayName,
          avatar: m.user.displayAvatarURL({ size: 32 }),
          roles: m.roles.cache.filter((r) => r.name !== "@everyone").map((r) => ({ id: r.id, name: r.name })),
          joinedAt: m.joinedAt ? m.joinedAt.toISOString() : null,
        }));
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, members: members.sort((a, b) => (a.displayName || a.username).localeCompare(b.displayName || b.username)) }));
      }
      res.writeHead(404);
      res.end(JSON.stringify({ ok: false, error: "Not found" }));
    } catch (err) {
      console.error("[Bot] API error:", err);
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: err.message || "Internal error" }));
    }
  });
  server.listen(BOT_API_PORT, "127.0.0.1", () => {
    console.log("[Bot] Management API on http://127.0.0.1:" + BOT_API_PORT);
  });
  server.on("error", (err) => {
    console.warn("[Bot] Management API port", BOT_API_PORT, "failed:", err.message);
  });

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
