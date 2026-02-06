const path = require("path");
require("dotenv").config();

module.exports = {
  token: process.env.DISCORD_TOKEN || "",
  prefix: process.env.PREFIX || "!",
  soundFolder: path.join(__dirname, "sounds"),
  dataDir: path.join(__dirname, "data"),
  defaultVolume: 1.0,
  maxQueueSize: 50,
  djRoleName: process.env.DJ_ROLE || "",
  cooldownMs: Math.max(0, parseInt(process.env.COOLDOWN_MS || "0", 10)),
};
