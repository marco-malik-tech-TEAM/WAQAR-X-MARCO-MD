"use strict";
const groupSettings = require("../utils/groupSettingsStore");
const { isOwner } = require("../utils/isOwner");
const { isSudo } = require("../utils/isSudo");
const { isSenderAdmin } = require("../utils/isAdmin");

module.exports = {
  name: "gcantidelete",
  aliases: ["gcad", "antideletegc", "gcdelete"],
  description: "Group anti-delete: deleted messages, photos, videos and voice notes are sent again in the same group. Usage: .gcantidelete on/off",
  async execute(sock, msg, args) {
    const jid = msg.key.remoteJid;
    const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg });
    if (!jid.endsWith("@g.us")) return reply("❌ *This command only works inside a group.*");

    let allowed = isOwner(msg) || isSudo(msg);
    if (!allowed) {
      try {
        const meta = await sock.groupMetadata(jid);
        allowed = isSenderAdmin(meta, msg.key.participant || msg.participant);
      } catch (_) {}
    }
    if (!allowed) return reply("❌ *Only the bot owner or a group admin can use this command.*");

    const a = String((args && args[0]) || "").toLowerCase();
    const now = !!groupSettings.get(jid, "gcantidelete", false);
    if (a === "on") {
      groupSettings.set(jid, "gcantidelete", true);
      return reply("🗑️ *GROUP ANTI-DELETE: ON* 🟢\n\nFrom now on, any message, photo, video, voice note, sticker or file deleted in this group will be sent again here.\n\n> _Powered by Marco x Waqar MD_");
    }
    if (a === "off") {
      groupSettings.set(jid, "gcantidelete", false);
      return reply("🗑️ *GROUP ANTI-DELETE: OFF* 🔴");
    }
    return reply("🗑️ *Group Anti-Delete:* " + (now ? "ON 🟢" : "OFF 🔴") + "\n\nUsage:\n• .gcantidelete on\n• .gcantidelete off");
  },
};
