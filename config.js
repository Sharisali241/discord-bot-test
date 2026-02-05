const path = require("path");
require("dotenv").config();

module.exports = {
  token: process.env.DISCORD_TOKEN || "",
  prefix: process.env.PREFIX || "!",
  soundFolder: path.join(__dirname, "sounds"),
  defaultVolume: 1.0,
  maxQueueSize: 50,
};
