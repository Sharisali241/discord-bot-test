const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const express = require("express");
const multer = require("multer");
const config = require("../config");

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

// Health check (for monitoring / load balancers)
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "soundboard-web", ts: Date.now() });
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

// API: list sounds
app.get("/api/sounds", (req, res) => {
  try {
    const names = getSounds();
    const prefix = config.prefix || "!";
    res.json({
      ok: true,
      prefix,
      sounds: names.map((name) => ({ name, command: `${prefix}play ${name}` })),
    });
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
    res.json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Delete failed." });
  }
});

// API: upload file (compress to Opus .ogg) — stricter rate limit
app.post("/api/upload", rateLimit(RATE_UPLOAD_WINDOW_MS, RATE_MAX_UPLOAD, "upload"), upload.single("sound"), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "No file selected." });
  const tempPath = req.file.path;
  const baseName = sanitizeName(path.parse(req.file.originalname || "sound").name);
  const outputPath = path.join(config.soundFolder, baseName + COMPRESSED_EXT);
  fs.mkdirSync(config.soundFolder, { recursive: true });
  try {
    await compressAudio(tempPath, outputPath);
    const name = path.parse(outputPath).name;
    res.json({ ok: true, name, command: `${config.prefix || "!"}play ${name}` });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || "Compression failed." });
  } finally {
    try { fs.unlinkSync(tempPath); } catch (_) {}
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

  try {
    fs.mkdirSync(config.soundFolder, { recursive: true });
    fs.writeFileSync(tempPath, buffer);
    await compressAudio(tempPath, outputPath);
    const name = path.parse(outputPath).name;
    res.json({ ok: true, name, command: `${config.prefix || "!"}play ${name}` });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || "Download or compression failed." });
  } finally {
    try { fs.unlinkSync(tempPath); } catch (_) {}
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log("[Web] Sound dashboard at http://localhost:" + PORT);
});
