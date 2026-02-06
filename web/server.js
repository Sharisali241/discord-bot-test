const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const express = require("express");
const multer = require("multer");
const config = require("../config");

const DATA_DIR = config.dataDir || path.join(__dirname, "..", "data");
const TAGS_PATH = path.join(DATA_DIR, "tags.json");
const PLAYCOUNT_PATH = path.join(DATA_DIR, "playcount.json");
const WEB_PASSWORD = process.env.WEB_PASSWORD || "";

function readJsonSync(filePath, defaultVal = {}) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {}
  return defaultVal;
}
function writeJsonSync(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
}

function authMiddleware(req, res, next) {
  if (!WEB_PASSWORD) return next();
  if (req.path === "/health") return next();
  const auth = req.headers.authorization;
  const token = (auth && auth.startsWith("Bearer ") ? auth.slice(7) : req.query?.token || "").trim();
  if (token === WEB_PASSWORD) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

const ffmpegPath = require("ffmpeg-static");
const app = express();
const PORT = process.env.WEB_PORT || 3000;

// --- Security & rate limiting ---
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

const rateLimitStore = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_GENERAL = 120;
const RATE_MAX_UPLOAD = 10;
const RATE_UPLOAD_WINDOW_MS = 5 * 60 * 1000;

function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
}

function rateLimit(windowMs, maxReq, keySuffix = "general") {
  return (req, res, next) => {
    const ip = getClientIp(req);
    const key = ip + ":" + keySuffix;
    const now = Date.now();
    let entry = rateLimitStore.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      rateLimitStore.set(key, entry);
    }
    entry.count++;
    if (entry.count > maxReq) {
      return res.status(429).json({ ok: false, error: "Too many requests. Try again later." });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of rateLimitStore.entries()) {
    if (now > e.resetAt) rateLimitStore.delete(ip);
  }
}, 60000);

const SOUND_EXTENSIONS = [".mp3", ".wav", ".ogg", ".flac", ".m4a"];
const COMPRESSED_EXT = ".ogg";
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB
// Opus 160k: excellent quality, much smaller than typical MP3/WAV
const OPUS_BITRATE = "160k";

function getSounds() {
  const soundFolder = config.soundFolder;
  if (!fs.existsSync(soundFolder)) return [];
  return fs.readdirSync(soundFolder)
    .filter((f) => {
      const ext = path.extname(f).toLowerCase();
      const full = path.join(soundFolder, f);
      return SOUND_EXTENSIONS.includes(ext) && fs.statSync(full).isFile();
    })
    .map((f) => path.parse(f).name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function getSoundsWithMeta() {
  const names = getSounds();
  const prefix = config.prefix || "!";
  const tagsData = readJsonSync(TAGS_PATH);
  const playData = readJsonSync(PLAYCOUNT_PATH);
  return names.map((name) => ({
    name,
    command: `${prefix}play ${name}`,
    tags: Array.isArray(tagsData[name]) ? tagsData[name] : [],
    playCount: typeof playData[name] === "number" ? playData[name] : 0,
  }));
}

function getSoundPath(name) {
  if (!name || typeof name !== "string") return null;
  const soundFolder = config.soundFolder;
  if (!fs.existsSync(soundFolder)) return null;
  const want = name.toLowerCase();
  const files = fs.readdirSync(soundFolder);
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const full = path.join(soundFolder, f);
    if (SOUND_EXTENSIONS.includes(ext) && fs.statSync(full).isFile() && path.parse(f).name.toLowerCase() === want) {
      return full;
    }
  }
  return null;
}

const MIME_BY_EXT = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac", ".m4a": "audio/mp4" };

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").slice(0, 80) || "sound";
}

/** Trim audio to [startSec, endSec] (seconds). Returns path to trimmed file. */
function trimAudio(inputPath, outputPath, startSec, endSec) {
  const duration = Math.max(0.01, endSec - startSec);
  return new Promise((resolve, reject) => {
    const args = ["-i", inputPath, "-ss", String(startSec), "-t", String(duration), "-c", "copy", "-y", outputPath];
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (c) => { stderr += c.toString(); });
    proc.on("close", (code) => {
      if (code === 0) return resolve(outputPath);
      reject(new Error("Trim failed: " + (stderr.slice(-500) || "unknown")));
    });
    proc.on("error", (err) => reject(err));
  });
}

/** Compress audio to Opus .ogg (high quality, small size). Returns output path. */
function compressAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-i", inputPath,
      "-c:a", "libopus",
      "-b:a", OPUS_BITRATE,
      "-vbr", "on",
      "-compression_level", "10",
      "-ar", "48000",
      "-ac", "2",
      "-y", outputPath
    ];
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (c) => { stderr += c.toString(); });
    proc.on("close", (code) => {
      if (code === 0) return resolve(outputPath);
      reject(new Error("Compression failed: " + (stderr.slice(-500) || "unknown")));
    });
    proc.on("error", (err) => reject(err));
  });
}

const tempDir = os.tmpdir();
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tempDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeExt = SOUND_EXTENSIONS.includes(ext) ? ext : ".mp3";
    cb(null, `discord-sound-${Date.now()}-${Math.random().toString(36).slice(2)}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (SOUND_EXTENSIONS.includes(ext)) return cb(null, true);
    cb(new Error("Invalid file type. Use .mp3, .wav, .ogg, .flac, or .m4a"));
  },
});

// Command list (matches bot commands for display + copy)
const COMMANDS = [
  { name: "help", usage: "[command]", description: "Show all commands or help for one", category: "General" },
  { name: "ping", usage: "", description: "Show bot latency", category: "General" },
  { name: "stats", usage: "", description: "Show bot stats and uptime", category: "General" },
  { name: "prefix", usage: "", description: "Show the command prefix", category: "General" },
  { name: "reload", usage: "", description: "Reload sound library from disk", category: "General" },
  { name: "join", usage: "", description: "Join your voice channel", category: "Voice" },
  { name: "leave", usage: "", description: "Leave voice and clear queue", category: "Voice" },
  { name: "play", usage: "<sound>", description: "Play a sound by name", category: "Voice" },
  { name: "add", usage: "<sound>", description: "Add sound to queue", category: "Voice" },
  { name: "stop", usage: "", description: "Stop and clear queue", category: "Voice" },
  { name: "skip", usage: "", description: "Skip current sound", category: "Voice" },
  { name: "pause", usage: "", description: "Pause playback", category: "Voice" },
  { name: "resume", usage: "", description: "Resume playback", category: "Voice" },
  { name: "remove", usage: "<position>", description: "Remove track from queue", category: "Voice" },
  { name: "move", usage: "<from> <to>", description: "Move track in queue", category: "Voice" },
  { name: "random", usage: "", description: "Play a random sound", category: "Voice" },
  { name: "queue", usage: "", description: "Show queue and now playing", category: "Voice" },
  { name: "volume", usage: "[0-200]", description: "Set volume %", category: "Voice" },
  { name: "loop", usage: "", description: "Toggle loop current track", category: "Voice" },
  { name: "loopqueue", usage: "", description: "Toggle loop queue", category: "Voice" },
  { name: "nowplaying", usage: "", description: "Show currently playing", category: "Voice" },
  { name: "shuffle", usage: "", description: "Shuffle the queue", category: "Voice" },
  { name: "library", usage: "", description: "List all sounds", category: "Voice" },
];

app.use(express.json());
app.use(rateLimit(RATE_WINDOW_MS, RATE_MAX_GENERAL));

// Health check: startTime changes when server restarts (so dashboard can auto-refresh)
const SERVER_START = Date.now();
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "soundboard-web", ts: Date.now(), startTime: SERVER_START });
});

if (WEB_PASSWORD) app.use("/api", authMiddleware);

const BOT_API_PORT = parseInt(process.env.BOT_API_PORT || "3001", 10);
const BOT_API_BASE = "http://127.0.0.1:" + BOT_API_PORT;
async function proxyToBot(pathname) {
  const res = await fetch(BOT_API_BASE + pathname, { headers: { Accept: "application/json" } });
  const data = await res.json().catch(() => ({ ok: false, error: "Invalid response" }));
  return { status: res.status, data };
}
app.post("/api/reload", async (req, res) => {
  try {
    const resBot = await fetch(BOT_API_BASE + "/reload", { method: "POST", headers: { Accept: "application/json" } });
    const data = await resBot.json().catch(() => ({ ok: false, error: "Invalid response" }));
    res.status(resBot.status).json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: "Bot API unavailable." });
  }
});
app.get("/api/guilds", async (req, res) => {
  try {
    const { status, data } = await proxyToBot("/guilds");
    res.status(status).json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: "Bot API unavailable. Is the bot running?" });
  }
});
app.get("/api/guilds/:id/channels", async (req, res) => {
  try {
    const { status, data } = await proxyToBot("/guilds/" + encodeURIComponent(req.params.id) + "/channels");
    res.status(status).json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: "Bot API unavailable." });
  }
});
app.get("/api/guilds/:id/members", async (req, res) => {
  try {
    const { status, data } = await proxyToBot("/guilds/" + encodeURIComponent(req.params.id) + "/members");
    res.status(status).json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: "Bot API unavailable." });
  }
});

app.post("/api/guilds/:id/channels/create-default", async (req, res) => {
  try {
    const pathname = "/guilds/" + encodeURIComponent(req.params.id) + "/channels/create-default";
    const resBot = await fetch(BOT_API_BASE + pathname, { method: "POST", headers: { Accept: "application/json" } });
    const data = await resBot.json().catch(() => ({ ok: false, error: "Invalid response" }));
    res.status(resBot.status).json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: "Bot API unavailable." });
  }
});

app.post("/api/guilds/:id/channels", express.json(), async (req, res) => {
  try {
    const pathname = "/guilds/" + encodeURIComponent(req.params.id) + "/channels";
    const resBot = await fetch(BOT_API_BASE + pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(req.body || {}),
    });
    const data = await resBot.json().catch(() => ({ ok: false, error: "Invalid response" }));
    res.status(resBot.status).json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: "Bot API unavailable." });
  }
});

async function proxyToBotWithBody(method, pathname, body) {
  const opts = { method, headers: { Accept: "application/json" } };
  if (body != null && (method === "POST" || method === "PATCH" || method === "PUT")) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const resBot = await fetch(BOT_API_BASE + pathname, opts);
  const data = await resBot.json().catch(() => ({ ok: false, error: "Invalid response" }));
  return { status: resBot.status, data };
}

app.patch("/api/guilds/:id/channels/:channelId", express.json(), async (req, res) => {
  try {
    const pathname = "/guilds/" + encodeURIComponent(req.params.id) + "/channels/" + encodeURIComponent(req.params.channelId);
    const { status, data } = await proxyToBotWithBody("PATCH", pathname, req.body);
    res.status(status).json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: "Bot API unavailable." });
  }
});
app.delete("/api/guilds/:id/channels/:channelId", async (req, res) => {
  try {
    const pathname = "/guilds/" + encodeURIComponent(req.params.id) + "/channels/" + encodeURIComponent(req.params.channelId);
    const resBot = await fetch(BOT_API_BASE + pathname, { method: "DELETE", headers: { Accept: "application/json" } });
    const data = await resBot.json().catch(() => ({ ok: false, error: "Invalid response" }));
    res.status(resBot.status).json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: "Bot API unavailable." });
  }
});
app.get("/api/guilds/:id/roles", async (req, res) => {
  try {
    const { status, data } = await proxyToBot("/guilds/" + encodeURIComponent(req.params.id) + "/roles");
    res.status(status).json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: "Bot API unavailable." });
  }
});
app.post("/api/guilds/:id/roles", express.json(), async (req, res) => {
  try {
    const pathname = "/guilds/" + encodeURIComponent(req.params.id) + "/roles";
    const { status, data } = await proxyToBotWithBody("POST", pathname, req.body);
    res.status(status).json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: "Bot API unavailable." });
  }
});
app.put("/api/guilds/:id/roles/reorder", express.json(), async (req, res) => {
  try {
    const pathname = "/guilds/" + encodeURIComponent(req.params.id) + "/roles/reorder";
    const { status, data } = await proxyToBotWithBody("PUT", pathname, req.body);
    res.status(status).json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: "Bot API unavailable." });
  }
});
app.patch("/api/guilds/:id/roles/:roleId", express.json(), async (req, res) => {
  try {
    const pathname = "/guilds/" + encodeURIComponent(req.params.id) + "/roles/" + encodeURIComponent(req.params.roleId);
    const { status, data } = await proxyToBotWithBody("PATCH", pathname, req.body);
    res.status(status).json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: "Bot API unavailable." });
  }
});
app.delete("/api/guilds/:id/roles/:roleId", async (req, res) => {
  try {
    const pathname = "/guilds/" + encodeURIComponent(req.params.id) + "/roles/" + encodeURIComponent(req.params.roleId);
    const resBot = await fetch(BOT_API_BASE + pathname, { method: "DELETE", headers: { Accept: "application/json" } });
    const data = await resBot.json().catch(() => ({ ok: false, error: "Invalid response" }));
    res.status(resBot.status).json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: "Bot API unavailable." });
  }
});
app.put("/api/guilds/:id/members/:userId/roles/:roleId", async (req, res) => {
  try {
    const pathname = "/guilds/" + encodeURIComponent(req.params.id) + "/members/" + encodeURIComponent(req.params.userId) + "/roles/" + encodeURIComponent(req.params.roleId);
    const resBot = await fetch(BOT_API_BASE + pathname, { method: "PUT", headers: { Accept: "application/json" } });
    const data = await resBot.json().catch(() => ({ ok: false, error: "Invalid response" }));
    res.status(resBot.status).json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: "Bot API unavailable." });
  }
});
app.delete("/api/guilds/:id/members/:userId/roles/:roleId", async (req, res) => {
  try {
    const pathname = "/guilds/" + encodeURIComponent(req.params.id) + "/members/" + encodeURIComponent(req.params.userId) + "/roles/" + encodeURIComponent(req.params.roleId);
    const resBot = await fetch(BOT_API_BASE + pathname, { method: "DELETE", headers: { Accept: "application/json" } });
    const data = await resBot.json().catch(() => ({ ok: false, error: "Invalid response" }));
    res.status(resBot.status).json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: "Bot API unavailable." });
  }
});

// API: list commands (for sidebar + copy) — must be before static
app.get("/api/commands", (req, res) => {
  try {
    const prefix = config.prefix || "!";
    const list = COMMANDS.map((c) => ({
      name: c.name,
      usage: c.usage,
      description: c.description,
      category: c.category,
      command: prefix + c.name + (c.usage ? " " + c.usage : ""),
    }));
    res.json({ ok: true, prefix, commands: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: list sounds (with tags and play count)
app.get("/api/sounds", (req, res) => {
  try {
    const sounds = getSoundsWithMeta();
    const prefix = config.prefix || "!";
    res.json({ ok: true, prefix, sounds });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: play stats (most played)
app.get("/api/stats", (req, res) => {
  try {
    const playData = readJsonSync(PLAYCOUNT_PATH);
    const list = Object.entries(playData)
      .filter(([, n]) => typeof n === "number" && n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([name, count]) => ({ name, count }));
    res.json({ ok: true, mostPlayed: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: stream sound file for preview (play/stop in browser)
app.get("/api/sounds/:name/audio", (req, res) => {
  const name = req.params.name;
  const filePath = getSoundPath(name);
  if (!filePath) return res.status(404).json({ ok: false, error: "Sound not found." });
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext] || "audio/mpeg";
  res.setHeader("Content-Type", mime);
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => res.status(500).end());
  stream.pipe(res);
});

// API: rename sound
app.patch("/api/sounds/:name", (req, res) => {
  const name = req.params.name;
  const newName = (req.body?.newName || "").trim();
  if (!name || name.includes("..") || /[<>:"/\\|?*]/.test(name)) {
    return res.status(400).json({ ok: false, error: "Invalid sound name." });
  }
  const safeNew = sanitizeName(newName);
  if (!safeNew || safeNew === name) return res.status(400).json({ ok: false, error: "Provide a valid new name." });
  const filePath = getSoundPath(name);
  if (!filePath) return res.status(404).json({ ok: false, error: "Sound not found." });
  const ext = path.extname(filePath);
  const newPath = path.join(path.dirname(filePath), safeNew + ext);
  if (fs.existsSync(newPath)) return res.status(400).json({ ok: false, error: "A sound with that name already exists." });
  try {
    fs.renameSync(filePath, newPath);
    const tagsData = readJsonSync(TAGS_PATH);
    const playData = readJsonSync(PLAYCOUNT_PATH);
    if (tagsData[name]) { tagsData[safeNew] = tagsData[name]; delete tagsData[name]; writeJsonSync(TAGS_PATH, tagsData); }
    if (playData[name] != null) { playData[safeNew] = playData[name]; delete playData[name]; writeJsonSync(PLAYCOUNT_PATH, playData); }
    res.json({ ok: true, name: safeNew, command: `${config.prefix || "!"}play ${safeNew}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Rename failed." });
  }
});

// API: set tags for a sound
app.patch("/api/sounds/:name/tags", (req, res) => {
  const name = req.params.name;
  const tags = Array.isArray(req.body?.tags) ? req.body.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  if (!name || name.includes("..") || /[<>:"/\\|?*]/.test(name)) {
    return res.status(400).json({ ok: false, error: "Invalid sound name." });
  }
  if (!getSoundPath(name)) return res.status(404).json({ ok: false, error: "Sound not found." });
  try {
    const tagsData = readJsonSync(TAGS_PATH);
    tagsData[name] = tags;
    writeJsonSync(TAGS_PATH, tagsData);
    res.json({ ok: true, name, tags });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Failed to set tags." });
  }
});

// API: delete sound (by name)
app.delete("/api/sounds/:name", (req, res) => {
  const name = req.params.name;
  if (!name || name.includes("..") || /[<>:"/\\|?*]/.test(name)) {
    return res.status(400).json({ ok: false, error: "Invalid sound name." });
  }
  const filePath = getSoundPath(name);
  if (!filePath) return res.status(404).json({ ok: false, error: "Sound not found." });
  try {
    fs.unlinkSync(filePath);
    const tagsPath = TAGS_PATH;
    const playPath = PLAYCOUNT_PATH;
    const tagsData = readJsonSync(tagsPath);
    const playData = readJsonSync(playPath);
    if (tagsData[name]) { delete tagsData[name]; writeJsonSync(tagsPath, tagsData); }
    if (playData[name] != null) { delete playData[name]; writeJsonSync(playPath, playData); }
    res.json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Delete failed." });
  }
});

// API: bulk delete sounds
app.post("/api/sounds/bulk-delete", (req, res) => {
  const names = Array.isArray(req.body?.names) ? req.body.names : [];
  if (names.length === 0) return res.status(400).json({ ok: false, error: "No names provided." });
  const deleted = [];
  const tagsData = readJsonSync(TAGS_PATH);
  const playData = readJsonSync(PLAYCOUNT_PATH);
  for (const name of names) {
    if (!name || name.includes("..") || /[<>:"/\\|?*]/.test(name)) continue;
    const filePath = getSoundPath(name);
    if (!filePath) continue;
    try {
      fs.unlinkSync(filePath);
      deleted.push(name);
      if (tagsData[name]) delete tagsData[name];
      if (playData[name] != null) delete playData[name];
    } catch (_) {}
  }
  if (deleted.length) {
    writeJsonSync(TAGS_PATH, tagsData);
    writeJsonSync(PLAYCOUNT_PATH, playData);
  }
  res.json({ ok: true, deleted, count: deleted.length });
});

// API: upload file (optional crop via startTime/endTime, then compress to Opus .ogg)
app.post("/api/upload", rateLimit(RATE_UPLOAD_WINDOW_MS, RATE_MAX_UPLOAD, "upload"), upload.single("sound"), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "No file selected." });
  const tempPath = req.file.path;
  const baseName = sanitizeName(path.parse(req.file.originalname || "sound").name);
  const outputPath = path.join(config.soundFolder, baseName + COMPRESSED_EXT);
  const startTime = req.body.startTime != null ? parseFloat(String(req.body.startTime), 10) : null;
  const endTime = req.body.endTime != null ? parseFloat(String(req.body.endTime), 10) : null;
  fs.mkdirSync(config.soundFolder, { recursive: true });
  let toCompress = tempPath;
  let trimPath = null;
  try {
    if (typeof startTime === "number" && typeof endTime === "number" && endTime > startTime && startTime >= 0) {
      trimPath = path.join(tempDir, `discord-trim-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
      await trimAudio(tempPath, trimPath, startTime, endTime);
      toCompress = trimPath;
    }
    await compressAudio(toCompress, outputPath);
    const name = path.parse(outputPath).name;
    res.json({ ok: true, name, command: `${config.prefix || "!"}play ${name}` });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || "Compression failed." });
  } finally {
    try { fs.unlinkSync(tempPath); } catch (_) {}
    if (trimPath) try { fs.unlinkSync(trimPath); } catch (_) {}
  }
}, (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ ok: false, error: "File too large. Max 15MB." });
  }
  res.status(400).json({ ok: false, error: err.message || "Upload failed." });
});

// API: upload from URL — stricter rate limit
app.post("/api/upload/url", rateLimit(RATE_UPLOAD_WINDOW_MS, RATE_MAX_UPLOAD, "upload"), async (req, res) => {
  const url = req.body?.url?.trim();
  if (!url) return res.status(400).json({ ok: false, error: "URL is required." });

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid URL." });
  }

  const disallowed = ["localhost", "127.0.0.1", "0.0.0.0", "file:"];
  const host = new URL(url).hostname.toLowerCase();
  if (disallowed.some((h) => host === h || host.endsWith("." + h))) {
    return res.status(400).json({ ok: false, error: "URL not allowed." });
  }

  const fetchOptions = {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "audio/*,*/*;q=0.9",
    },
  };

  let response;
  try {
    response = await fetch(url, fetchOptions);
  } catch (e) {
    return res.status(400).json({ ok: false, error: "Could not fetch URL: " + (e.message || "timeout or error") });
  }

  if (!response.ok) {
    return res.status(400).json({ ok: false, error: "URL returned status " + response.status + ". Use a direct link to the audio file." });
  }

  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (contentType.includes("text/html") || contentType.includes("application/xhtml") || contentType.includes("text/plain")) {
    return res.status(400).json({ ok: false, error: "URL points to a web page, not an audio file. Paste a direct link to the .mp3/.ogg/.wav file." });
  }

  const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
  if (contentLength > MAX_FILE_SIZE) {
    return res.status(400).json({ ok: false, error: "File too large. Max 15MB." });
  }

  let buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (e) {
    return res.status(400).json({ ok: false, error: "Failed to download file: " + (e.message || "invalid response") });
  }

  if (buffer.length === 0) {
    return res.status(400).json({ ok: false, error: "URL returned an empty file." });
  }
  if (buffer.length > MAX_FILE_SIZE) {
    return res.status(400).json({ ok: false, error: "File too large. Max 15MB." });
  }

  const first = buffer.slice(0, 12);
  const startsWith = (a) => { const b = Buffer.from(a, "utf8"); return first.length >= b.length && first.slice(0, b.length).compare(b) === 0; };
  if (startsWith("<!") || startsWith("<?") || startsWith("<htm") || startsWith("<HTM") || (first[0] === 0x3c && (first[1] === 0x21 || first[1] === 0x3f))) {
    return res.status(400).json({ ok: false, error: "URL returned a web page, not audio. Use a direct link to the audio file (e.g. ending in .mp3)." });
  }

  const isMp3 = (buf) => buf.length >= 3 && (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) || (buf.length >= 10 && buf.toString("utf8", 0, 3) === "ID3");
  const isOgg = (buf) => buf.length >= 4 && buf.toString("utf8", 0, 4) === "OggS";
  const isWav = (buf) => buf.length >= 12 && buf.toString("utf8", 0, 4) === "RIFF" && buf.toString("utf8", 8, 12) === "WAVE";
  const isFlac = (buf) => buf.length >= 4 && buf.toString("utf8", 0, 4) === "fLaC";
  const isM4a = (buf) => buf.length >= 8 && (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70);
  const looksLikeAudio = isMp3(buffer) || isOgg(buffer) || isWav(buffer) || isFlac(buffer) || isM4a(buffer);
  if (!looksLikeAudio) {
    return res.status(400).json({ ok: false, error: "URL did not return a valid audio file (MP3, WAV, OGG, FLAC, M4A). The link may be a page or unsupported format." });
  }

  let ext = ".mp3";
  const urlPath = new URL(url).pathname;
  const urlExt = path.extname(urlPath).toLowerCase();
  if (SOUND_EXTENSIONS.includes(urlExt)) ext = urlExt;
  else if (isOgg(buffer)) ext = ".ogg";
  else if (isWav(buffer)) ext = ".wav";
  else if (isFlac(buffer)) ext = ".flac";
  else if (isM4a(buffer)) ext = ".m4a";
  else if (isMp3(buffer)) ext = ".mp3";
  else if (contentType.includes("ogg")) ext = ".ogg";
  else if (contentType.includes("wav")) ext = ".wav";
  else if (contentType.includes("flac")) ext = ".flac";
  else if (contentType.includes("mp4") || contentType.includes("m4a")) ext = ".m4a";

  const nameFromUrl = path.parse(urlPath).name || "sound";
  const baseName = sanitizeName(nameFromUrl);
  const tempPath = path.join(tempDir, `discord-sound-url-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  const outputPath = path.join(config.soundFolder, baseName + COMPRESSED_EXT);
  const startTime = req.body.startTime != null ? parseFloat(String(req.body.startTime), 10) : null;
  const endTime = req.body.endTime != null ? parseFloat(String(req.body.endTime), 10) : null;

  let trimPath = null;
  try {
    fs.mkdirSync(config.soundFolder, { recursive: true });
    fs.writeFileSync(tempPath, buffer);
    let toCompress = tempPath;
    if (typeof startTime === "number" && typeof endTime === "number" && endTime > startTime && startTime >= 0) {
      trimPath = path.join(tempDir, `discord-trim-url-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
      await trimAudio(tempPath, trimPath, startTime, endTime);
      toCompress = trimPath;
    }
    await compressAudio(toCompress, outputPath);
    const name = path.parse(outputPath).name;
    res.json({ ok: true, name, command: `${config.prefix || "!"}play ${name}` });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || "Download or compression failed." });
  } finally {
    try { fs.unlinkSync(tempPath); } catch (_) {}
    if (trimPath) try { fs.unlinkSync(trimPath); } catch (_) {}
  }
});

const publicDir = path.join(__dirname, "public");
// Serve index.html with strong no-cache so dashboard always reflects latest deploy
app.get(["/", "/index.html"], (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.sendFile(path.join(publicDir, "index.html"));
});
app.use(express.static(publicDir, {
  maxAge: 0,
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    if (filePath && (filePath.endsWith(".html") || filePath.endsWith(".htm"))) {
      res.setHeader("Pragma", "no-cache");
    }
  },
}));

app.listen(PORT, () => {
  console.log("[Web] Sound dashboard at http://localhost:" + PORT);
});
