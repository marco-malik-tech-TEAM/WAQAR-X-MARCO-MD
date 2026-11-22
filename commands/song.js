"use strict";
const audioFetch = require("../utils/audioFetch");
module.exports = {
  name: "song",
  aliases: [],
  description: "Download a song from YouTube. Usage: .song <song name or link>",
  async execute(sock, msg, args) {
    return audioFetch.run(sock, msg, (args || []).join(" "), "song", "❌ Usage: .song <song name or link>");
  },
};
