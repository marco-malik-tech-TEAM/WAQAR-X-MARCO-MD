"use strict";
const viewOnce = require("../utils/viewOnce");
module.exports = {
  name: "vv",
  aliases: ["viewonce", "readvv"],
  description: "Open a view-once photo/video/voice note. Reply to it with .vv",
  async execute(sock, msg) {
    const jid = msg.key.remoteJid;
    try {
      try { await sock.sendMessage(jid, { react: { text: "⏳", key: msg.key } }); } catch (_) {}
      const r = await viewOnce.extract(sock, msg);
      if (!r.ok) {
        try { await sock.sendMessage(jid, { react: { text: "❌", key: msg.key } }); } catch (_) {}
        return await sock.sendMessage(jid, { text: r.text }, { quoted: msg });
      }
      await sock.sendMessage(jid, viewOnce.toPayload(r, (r.caption ? r.caption + "\n\n" : "") + "👁️ _Retrieved by MARCO X WAQAR MD_"), { quoted: msg });
      try { await sock.sendMessage(jid, { react: { text: "✅", key: msg.key } }); } catch (_) {}
    } catch (e) {
      console.error("[vv]", e && e.message);
      try { await sock.sendMessage(jid, { text: "❌ Failed to retrieve view-once media: " + (e && e.message) }, { quoted: msg }); } catch (_) {}
    }
  },
};
