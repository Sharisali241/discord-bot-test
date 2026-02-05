const { getGuildState } = require("../utils/voiceManager");
const config = require("../config");

function requireVoice(msg) {
  const channel = msg.member?.voice?.channel;
  if (!channel) {
    msg.reply("You need to be in a voice channel first.");
    return null;
  }
  return channel;
}

const voiceCommands = [
  {
    name: "join",
    aliases: ["j", "connect"],
    description: "Join your current voice channel",
    category: "Voice",
    execute(msg) {
      const channel = requireVoice(msg);
      if (!channel) return;
      const state = getGuildState(msg.guild.id);
      state.join(channel);
      msg.reply(`Joined **${channel.name}**. Use \`${config.prefix}play <sound>\` to play.`);
    },
  },
  {
    name: "leave",
    aliases: ["disconnect", "dc", "quit"],
    description: "Leave the voice channel and clear the queue",
    category: "Voice",
    execute(msg) {
      const state = getGuildState(msg.guild.id);
      state.leave();
      msg.reply("Left the voice channel.");
    },
  },
  {
    name: "play",
    aliases: ["p"],
    description: "Play a sound by name (joins channel if needed)",
    usage: "<sound name>",
    category: "Voice",
    async execute(msg, args) {
      const soundName = args[0];
      if (!soundName) {
        return msg.reply(`Usage: \`${config.prefix}play <sound name>\`. Use \`${config.prefix}library\` for the list.`);
      }
      if (!msg.guild) return msg.reply("This command only works in a server.");
      const channel = requireVoice(msg);
      if (!channel) return;
      const state = getGuildState(msg.guild.id);
      if (!state.connection) state.join(channel);
      const result = state.play(soundName);
      if (!result.ok) {
        if (result.error === "not_found") {
          const list = state.getAllSounds().join(", ") || "none";
          return msg.reply(`Sound **${soundName}** not found. Available: ${list || "(add files to the sounds folder)"}.`);
        }
        if (result.error === "queue_full") return msg.reply("Queue is full. Try again later.");
        return msg.reply("Could not play. Make sure I'm in a voice channel.");
      }
      if (result.queued) {
        const pos = state.getQueue().length;
        msg.reply(`Added **${result.name}** to the queue (position ${pos}).`);
      } else {
        msg.reply(`Now playing **${result.name}**.`);
      }
    },
  },
  {
    name: "add",
    aliases: ["queue", "q"],
    description: "Add a sound to the queue without playing now",
    usage: "<sound name>",
    category: "Voice",
    execute(msg, args) {
      const soundName = args[0];
      if (!soundName) {
        return msg.reply(`Usage: \`${config.prefix}add <sound name>\`.`);
      }
      const channel = requireVoice(msg);
      if (!channel) return;
      const state = getGuildState(msg.guild.id);
      if (!state.connection) state.join(channel);
      const result = state.addToQueue(soundName);
      if (!result.ok) {
        if (result.error === "not_found") {
          return msg.reply(`Sound **${soundName}** not found. Use \`${config.prefix}library\`.`);
        }
        if (result.error === "queue_full") return msg.reply("Queue is full.");
        return msg.reply("Join a voice channel and try again.");
      }
      msg.reply(`Added **${result.name}** to the queue (position ${result.position}).`);
    },
  },
  {
    name: "stop",
    aliases: ["clear"],
    description: "Stop playback and clear the queue",
    category: "Voice",
    execute(msg) {
      const state = getGuildState(msg.guild.id);
      state.stop();
      msg.reply("Stopped and cleared the queue.");
    },
  },
  {
    name: "skip",
    aliases: ["s", "next"],
    description: "Skip the current sound",
    category: "Voice",
    execute(msg) {
      const state = getGuildState(msg.guild.id);
      if (!state.player) return msg.reply("Nothing is playing.");
      state.skip();
      msg.reply("Skipped.");
    },
  },
  {
    name: "queue",
    aliases: ["list", "qlist"],
    description: "Show the current queue and now playing",
    category: "Voice",
    execute(msg) {
      const state = getGuildState(msg.guild.id);
      const now = state.getNowPlaying();
      const queue = state.getQueue();
      if (!now && queue.length === 0) {
        return msg.reply("Queue is empty. Use `" + config.prefix + "play <sound>` to add something.");
      }
      let text = "";
      if (now) text += `**Now playing:** ${now.name}\n`;
      if (queue.length > 0) {
        text += `**Queue:** ${queue.map((t, i) => `${i + 1}. ${t.name}`).join(" | ")}`;
      }
      msg.reply(text || "Queue is empty.");
    },
  },
  {
    name: "volume",
    aliases: ["vol", "v"],
    description: "Set volume (0–200%). Default 100%",
    usage: "[0-200]",
    category: "Voice",
    execute(msg, args) {
      const state = getGuildState(msg.guild.id);
      const val = args[0];
      if (val === undefined || val === "") {
        return msg.reply(`Current volume: **${Math.round(state.volume * 100)}%**. Use \`${config.prefix}volume <0-200>\` to change.`);
      }
      const num = parseFloat(val);
      if (isNaN(num) || num < 0 || num > 200) {
        return msg.reply("Volume must be a number between 0 and 200.");
      }
      state.setVolume(num / 100);
      msg.reply(`Volume set to **${Math.round(num)}%**.`);
    },
  },
  {
    name: "loop",
    aliases: ["repeat", "looptrack"],
    description: "Toggle loop for the current track",
    category: "Voice",
    execute(msg) {
      const state = getGuildState(msg.guild.id);
      state.loopTrack = !state.loopTrack;
      msg.reply(state.loopTrack ? "Loop track **on**. Current sound will repeat." : "Loop track **off**.");
    },
  },
  {
    name: "loopqueue",
    aliases: ["lq", "loopall"],
    description: "Toggle loop for the entire queue",
    category: "Voice",
    execute(msg) {
      const state = getGuildState(msg.guild.id);
      state.loopQueue = !state.loopQueue;
      msg.reply(state.loopQueue ? "Loop queue **on**." : "Loop queue **off**.");
    },
  },
  {
    name: "nowplaying",
    aliases: ["np", "current"],
    description: "Show the currently playing sound",
    category: "Voice",
    execute(msg) {
      const state = getGuildState(msg.guild.id);
      const now = state.getNowPlaying();
      if (!now) return msg.reply("Nothing is playing.");
      msg.reply(`Now playing: **${now.name}**.`);
    },
  },
  {
    name: "shuffle",
    aliases: ["mix"],
    description: "Shuffle the queue",
    category: "Voice",
    execute(msg) {
      const state = getGuildState(msg.guild.id);
      const n = state.shuffleQueue();
      if (n === 0) return msg.reply("Queue is empty or has only one item.");
      msg.reply(`Shuffled ${n} item(s) in the queue.`);
    },
  },
  {
    name: "library",
    aliases: ["sounds", "soundslist"],
    description: "List all available sounds",
    category: "Voice",
    execute(msg) {
      const state = getGuildState(msg.guild.id);
      const list = state.getAllSounds();
      if (list.length === 0) {
        return msg.reply("No sounds loaded. Add .mp3, .wav, or .ogg files to the `sounds` folder.");
      }
      msg.reply(`**Available sounds (${list.length}):** ${list.join(", ")}`);
    },
  },
];

module.exports = voiceCommands;
