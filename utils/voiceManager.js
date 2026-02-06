const path = require("path");
const fs = require("fs");
const config = require("../config");

function recordPlayCount(soundName) {
  if (!soundName || !config.dataDir) return;
  const filePath = path.join(config.dataDir, "playcount.json");
  setImmediate(() => {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      let data = {};
      if (fs.existsSync(filePath)) {
        try {
          data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        } catch (_) {}
      }
      data[soundName] = (data[soundName] || 0) + 1;
      fs.writeFileSync(filePath, JSON.stringify(data, null, 0));
    } catch (_) {}
  });
}

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
} = require("@discordjs/voice");

const SOUND_EXTENSIONS = [".mp3", ".wav", ".ogg", ".flac", ".m4a"];

class GuildVoiceState {
  constructor(guildId) {
    this.guildId = guildId;
    this.connection = null;
    this.player = null;
    this.queue = [];
    this.loopTrack = false;
    this.loopQueue = false;
    this.volume = config.defaultVolume;
    this.currentTrack = null;
    this.sounds = {};
    this.aliases = {};
    this._loadSounds();
    this._loadAliases();
  }

  _loadAliases() {
    const aliasesPath = path.join(config.soundFolder, "aliases.json");
    this.aliases = {};
    try {
      if (fs.existsSync(aliasesPath)) {
        const data = JSON.parse(fs.readFileSync(aliasesPath, "utf8"));
        if (data && typeof data === "object") {
          Object.entries(data).forEach(([alias, realName]) => {
            if (alias && realName && typeof realName === "string") {
              this.aliases[this._normalize(alias)] = realName.trim();
            }
          });
        }
      }
    } catch (_) {}
  }

  _loadSounds() {
    const soundFolder = config.soundFolder;
    if (!fs.existsSync(soundFolder)) return;
    const files = fs.readdirSync(soundFolder);
    files.forEach((file) => {
      const fullPath = path.join(soundFolder, file);
      if (fs.statSync(fullPath).isFile() && SOUND_EXTENSIONS.includes(path.extname(file).toLowerCase())) {
        this.sounds[path.parse(file).name.toLowerCase()] = fullPath;
      }
    });
  }

  /** Normalize for fuzzy match: lowercase, remove underscores and spaces so "Voicy_No_God_PleaseNo" matches "Voicy_No_God_Please_No_" */
  _normalize(s) {
    return (s || "").toLowerCase().replace(/[\s_]/g, "");
  }

  getSound(name) {
    if (!name || typeof name !== "string") return null;
    const want = name.trim();
    const wantNorm = this._normalize(want);
    const resolvedName = this.aliases[wantNorm] || want;
    let key = Object.keys(this.sounds).find((k) => k.toLowerCase() === resolvedName.toLowerCase());
    if (!key && wantNorm) {
      key = Object.keys(this.sounds).find((k) => this._normalize(k) === this._normalize(resolvedName));
    }
    return key ? { name: key, path: this.sounds[key] } : null;
  }

  getAllSounds() {
    return Object.keys(this.sounds);
  }

  /** Reload sound list and aliases from disk (call after adding/removing files). */
  reloadSounds() {
    this.sounds = {};
    this._loadSounds();
    this._loadAliases();
  }

  join(channel) {
    if (this.connection) return this.connection;
    const guild = channel.guild;
    if (!guild?.voiceAdapterCreator) throw new Error("Voice not available for this server. Try again in a moment.");
    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    if (!this.player) {
      this.player = createAudioPlayer();
      this._bindPlayerEvents();
    }
    this.connection.subscribe(this.player);
    return this.connection;
  }

  _bindPlayerEvents() {
    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this.loopTrack && this.currentTrack) {
        this._playFile(this.currentTrack.path);
        return;
      }
      this.currentTrack = null;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        this._playFile(next.path, next.name);
        if (this.loopQueue && next) this.queue.push(next);
      } else {
        setTimeout(() => {
          if (this.player.state.status === AudioPlayerStatus.Idle && this.queue.length === 0) {
            this.leave();
          }
        }, 60000);
      }
    });
    this.player.on("error", (err) => {
      console.error("AudioPlayer error:", err);
      this.currentTrack = null;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        this._playFile(next.path, next.name);
      }
    });
  }

  _playFile(filePath, displayName = null) {
    try {
      if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
      // Use path with forward slashes so FFmpeg (via prism-media) gets a safe path on Windows
      const safePath = path.resolve(filePath).split(path.sep).join("/");
      const resource = createAudioResource(safePath, {
        inlineVolume: true,
      });
      if (resource.volume) resource.volume.setVolume(this.volume);
      this.currentTrack = displayName ? { path: filePath, name: displayName } : { path: filePath, name: path.basename(filePath, path.extname(filePath)) };
      this.player.play(resource);
      recordPlayCount(this.currentTrack.name);
    } catch (err) {
      const message = err?.message || String(err);
      throw new Error(`Playback failed (${path.basename(filePath)}): ${message}`);
    }
  }

  play(soundName) {
    const sound = this.getSound(soundName);
    if (!sound) return { ok: false, error: "not_found" };
    if (!this.connection || !this.player) return { ok: false, error: "not_connected" };
    const track = { name: sound.name, path: sound.path };
    if (this.player.state.status !== AudioPlayerStatus.Idle || this.currentTrack) {
      if (this.queue.length >= config.maxQueueSize) return { ok: false, error: "queue_full" };
      this.queue.push(track);
      return { ok: true, queued: true, name: sound.name };
    }
    this._playFile(sound.path, sound.name);
    return { ok: true, queued: false, name: sound.name };
  }

  addToQueue(soundName) {
    const sound = this.getSound(soundName);
    if (!sound) return { ok: false, error: "not_found" };
    if (!this.connection || !this.player) return { ok: false, error: "not_connected" };
    if (this.queue.length >= config.maxQueueSize) return { ok: false, error: "queue_full" };
    this.queue.push({ name: sound.name, path: sound.path });
    return { ok: true, name: sound.name, position: this.queue.length };
  }

  skip() {
    if (!this.player) return false;
    this.player.stop();
    return true;
  }

  pause() {
    if (!this.player) return false;
    return this.player.pause();
  }

  unpause() {
    if (!this.player) return false;
    return this.player.unpause();
  }

  isPaused() {
    return this.player?.state?.status === AudioPlayerStatus.Paused;
  }

  removeFromQueue(index) {
    const i = parseInt(index, 10);
    if (isNaN(i) || i < 1 || i > this.queue.length) return { ok: false, error: "invalid_index" };
    const removed = this.queue.splice(i - 1, 1)[0];
    return { ok: true, name: removed?.name };
  }

  moveInQueue(from, to) {
    const f = parseInt(from, 10);
    const t = parseInt(to, 10);
    if (isNaN(f) || isNaN(t) || f < 1 || t < 1 || f > this.queue.length || t > this.queue.length) {
      return { ok: false, error: "invalid_index" };
    }
    if (f === t) return { ok: true, name: this.queue[f - 1]?.name };
    const item = this.queue.splice(f - 1, 1)[0];
    this.queue.splice(t - 1, 0, item);
    return { ok: true, name: item?.name };
  }

  stop() {
    this.queue = [];
    this.currentTrack = null;
    if (this.player) this.player.stop();
    return true;
  }

  setVolume(value) {
    const v = Math.max(0, Math.min(2, value));
    this.volume = v;
    return v;
  }

  leave() {
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }
    this.queue = [];
    this.currentTrack = null;
  }

  getQueue() {
    return [...this.queue];
  }

  getNowPlaying() {
    return this.currentTrack;
  }

  shuffleQueue() {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
    return this.queue.length;
  }
}

const guildStates = new Map();

function getGuildState(guildId) {
  if (!guildStates.has(guildId)) {
    guildStates.set(guildId, new GuildVoiceState(guildId));
  }
  return guildStates.get(guildId);
}

function getExistingConnection(guildId) {
  return getVoiceConnection(guildId);
}

/** Reload sounds from disk for all guilds (new files appear without bot restart). */
function reloadAllSounds() {
  for (const state of guildStates.values()) {
    state.reloadSounds();
  }
}

module.exports = {
  getGuildState,
  getExistingConnection,
  reloadAllSounds,
  GuildVoiceState,
};
