const config = require("../config");

function getAllCommands() {
  const { getAllCommands: get } = require("./index");
  return get();
}

const generalCommands = [
  {
    name: "help",
    aliases: ["h", "commands"],
    description: "Show all commands or help for a specific command",
    usage: "[command]",
    category: "General",
    execute(msg, args) {
      const cmdName = args[0]?.toLowerCase();
      if (cmdName) {
        const allCommands = getAllCommands();
        const cmd = allCommands.find(
          (c) => c.name.toLowerCase() === cmdName || (c.aliases && c.aliases.includes(cmdName))
        );
        if (!cmd) {
          return msg.reply(`Unknown command \`${cmdName}\`. Use \`${config.prefix}help\` for the full list.`);
        }
        const usage = cmd.usage ? ` ${cmd.usage}` : "";
        const aliases = cmd.aliases?.length ? ` (aliases: ${cmd.aliases.join(", ")})` : "";
        return msg.reply(`**${config.prefix}${cmd.name}${usage}**${aliases}\n${cmd.description}`);
      }
      const allCommands = getAllCommands();
      const byCategory = {};
      allCommands.forEach((c) => {
        const cat = c.category || "Other";
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(`\`${config.prefix}${c.name}\` — ${c.description}`);
      });
      const lines = ["**Commands** (use `" + config.prefix + "help <command>` for details)"];
      Object.entries(byCategory).forEach(([cat, cmds]) => {
        lines.push(`\n**${cat}**`);
        lines.push(cmds.join("\n"));
      });
      lines.push(`\nPrefix: \`${config.prefix}\` | Sounds: put files in \`sounds\` folder`);
      msg.reply(lines.join("\n"));
    },
  },
  {
    name: "ping",
    aliases: ["latency"],
    description: "Show bot latency",
    category: "General",
    execute(msg) {
      const sent = Date.now();
      msg.reply("Pinging…").then((reply) => {
        const ms = Date.now() - sent;
        reply.edit(`Pong! Latency: **${ms}ms** | WebSocket: **${msg.client.ws.ping}ms**`);
      });
    },
  },
  {
    name: "stats",
    aliases: ["info", "about", "uptime"],
    description: "Show bot stats and uptime",
    category: "General",
    execute(msg) {
      const uptime = process.uptime();
      const days = Math.floor(uptime / 86400);
      const hours = Math.floor((uptime % 86400) / 3600);
      const mins = Math.floor((uptime % 3600) / 60);
      const uptimeStr = [days > 0 && `${days}d`, hours > 0 && `${hours}h`, `${mins}m`].filter(Boolean).join(" ");
      const guilds = msg.client.guilds.cache.size;
      const users = msg.client.guilds.cache.reduce((a, g) => a + g.memberCount, 0);
      msg.reply(
        `**Bot stats**\n` +
          `Servers: **${guilds}** | Users: **${users}**\n` +
          `Uptime: **${uptimeStr}**\n` +
          `Prefix: \`${config.prefix}\``
      );
    },
  },
  {
    name: "prefix",
    aliases: [],
    description: "Show the current command prefix",
    category: "General",
    execute(msg) {
      msg.reply(`Current prefix: \`${config.prefix}\` (change via \`PREFIX\` in .env).`);
    },
  },
  {
    name: "reload",
    aliases: ["refresh", "reloadsounds"],
    description: "Reload sound library from disk (new files appear without restart)",
    category: "General",
    execute(msg) {
      const { reloadAllSounds, getGuildState } = require("../utils/voiceManager");
      reloadAllSounds();
      const state = getGuildState(msg.guild.id);
      const count = state.getAllSounds().length;
      msg.reply(`Sound library reloaded. **${count}** sound(s) available.`);
    },
  },
];

module.exports = generalCommands;
