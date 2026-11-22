"use strict";
/**
 * .setstatusemoji <emoji>   -> the bot views every status and reacts with THIS emoji
 * .setstatusemoji off       -> stop reacting
 * .setstatusemoji random    -> go back to random emojis
 * .statusemoji (alias)      -> shows the current setting
 */
const settingsStore = require("../utils/settingsStore");
const { isOwner } = require("../utils/isOwner");

// one emoji (with optional skin tone / ZWJ / variation selector)
const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3)(?:\uFE0F|\u200D(?:\p{Extended_Pictographic})\uFE0F?|[\u{1F3FB}-\u{1F3FF}])*$/u;

module.exports = {
  name: "setstatusemoji",
  aliases: ["statusemoji", "setstatusreact", "statusreact"],
  description: "Set the emoji the bot reacts with on every status. Usage: .setstatusemoji 😍 | off | random",
  async execute(sock, msg, args) {
    const jid = msg.key.remoteJid;
    if (!isOwner(msg)) return;
    const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg });
    const arg = (args[0] || "").trim();

    if (!arg) {
      const on = settingsStore.get("autolike", false);
      const emo = settingsStore.get("statusemoji", "");
      return reply(
        "👀 *Status Seen + React*\n\n" +
        "• React: " + (on ? "ON 🟢" : "OFF 🔴") + "\n" +
        "• Emoji: " + (emo || "random") + "\n\n" +
        "Usage:\n.setstatusemoji 😍  → set one emoji\n.setstatusemoji random  → random emojis\n.setstatusemoji off  → stop reacting"
      );
    }
    const low = arg.toLowerCase();
    if (low === "off") {
      settingsStore.set("autolike", false);
      return reply("🔴 Status react is now *OFF*. (Status view stays as it is: use .autoview on/off)");
    }
    if (low === "random") {
      settingsStore.set("statusemoji", "");
      settingsStore.set("autolike", true);
      settingsStore.set("autoview", true);
      return reply("🎲 Status react is *ON* with *random* emojis.");
    }
    if (!EMOJI_RE.test(arg)) {
      return reply("❌ Send ONE emoji only.\nExample: .setstatusemoji 😍");
    }
    settingsStore.set("statusemoji", arg);
    settingsStore.set("autolike", true);
    settingsStore.set("autoview", true);
    return reply("✅ Done! The bot now views every status and reacts with " + arg);
  },
};
