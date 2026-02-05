const voiceCommands = require("./voice");
const generalCommands = require("./general");

const all = [...voiceCommands, ...generalCommands];
const byName = new Map();
const byAlias = new Map();

all.forEach((cmd) => {
  byName.set(cmd.name.toLowerCase(), cmd);
  (cmd.aliases || []).forEach((a) => byAlias.set(a.toLowerCase(), cmd));
});

function resolveCommand(input) {
  const lower = input.toLowerCase();
  return byName.get(lower) || byAlias.get(lower) || null;
}

function getAllCommands() {
  return all;
}

module.exports = {
  getAllCommands,
  resolveCommand,
};
