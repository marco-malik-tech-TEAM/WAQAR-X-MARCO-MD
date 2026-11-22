"use strict";
const { jidNormalizedUser } = require("@whiskeysockets/baileys");
const { isOwner } = require("../utils/isOwner");
const viewOnce = require("../utils/viewOnce");
module.exports = {
  name: "vv2",
  aliases: ["mmh", "uhm"],
  noprefix: ["😂", "😍", "🌚", "🌝", "😊", "😉", "🙄", "😅", "🫠", "🙂", "🥰", "😘", "🤩", "😙", "🤢", "🤔", "🫣"],
  description: "Reveal a quoted view-once message and DM it to the owner (owner-only)",
  async execute(sock, msg) {
    if (!isOwner(msg)) return;
    const me = sock.user && sock.user.id ? jidNormalizedUser(sock.user.id) : null;
    if (!me) return;
    try {
      const r = await viewOnce.extract(sock, msg);
      // emoji replies are "no-prefix" triggers: stay silent when it is not a view-once message
      if (!r.ok) { if (r.reason === "download") await sock.sendMessage(me, { text: r.text }); return; }
      await sock.sendMessage(me, viewOnce.toPayload(r, "Retrieved by MARCO X WAQAR MD!" + (r.caption ? "\n" + r.caption : "")), { quoted: msg });
    } catch (e) { console.error("[vv2]", e && e.message); }
  },
};
