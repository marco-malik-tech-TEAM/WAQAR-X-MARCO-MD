"use strict";
const audioFetch = require("../utils/audioFetch");
module.exports = {
  name: "play2",
  aliases: ["yta2"],
  description: "Download a song as audio + mp3 file. Usage: .play2 <song name or link>",
  async execute(sock, msg, args) {
    return audioFetch.run(sock, msg, (args || []).join(" "), "play2", "🎵 *MARCO X WAQAR MD PLAY2*\n\nExample:\n.play2 Shape of You");
  },
};
