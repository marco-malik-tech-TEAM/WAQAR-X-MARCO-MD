"use strict";
const audioFetch = require("../utils/audioFetch");
module.exports = {
  name: "play",
  aliases: [],
  description: "Search and download a song from YouTube. Usage: .play <song name or link>",
  async execute(sock, msg, args) {
    return audioFetch.run(sock, msg, (args || []).join(" "), "play", "🎵 *MARCO X WAQAR MD PLAY*\n\nExample:\n.play Shape of You");
  },
};
