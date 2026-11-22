"use strict";
/**
 * .rs  =  Reaction Sticker (automatic sticker reactions)
 *
 *   .rs 30            turn ON in THIS chat: the bot answers incoming messages with a random
 *                     sticker, at most once every 30 seconds (min 5, max 3600)
 *   .rs off           turn OFF in this chat
 *   .rs all 30        turn ON in EVERY chat (30 s gap per chat)
 *   .rs alloff        turn everything OFF
 *   .rs add           reply to a sticker -> saves it into the reaction pack
 *   .rs list          shows how many stickers are in the pack and the current setup
 *   .rs clear         deletes the stickers you added (the built-in pack in assets/rs stays)
 *
 * Built-in stickers: put .webp files into  assets/rs/  (they ship with the bot).
 * Stickers added with ".rs add" are stored per paired number (data/rs_stickers/).
 */
const fs = require("fs");
const path = require("path");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const settingsStore = require("../utils/settingsStore");
const { isOwner } = require("../utils/isOwner");
const logger = require("../utils/logger");
const { ROOT } = require("../utils/paths");

const BUILTIN_DIR = path.join(__dirname, "..", "assets", "rs");
const USER_DIR = path.join(ROOT, "data", "rs_stickers");
const KEY = "rs_setup";
const DEFAULT_GAP = 30, MIN_GAP = 5, MAX_GAP = 3600;
const silent = { level: "silent", trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };

const lastSent = new Map(); // chat -> timestamp

function setup() {
  const s = settingsStore.get(KEY, null);
  return s && typeof s === "object" ? { all: s.all || 0, chats: s.chats || {} } : { all: 0, chats: {} };
}
const save = (s) => settingsStore.set(KEY, s);

function files(dir) {
  try { return fs.readdirSync(dir).filter((f) => /\.webp$/i.test(f)).map((f) => path.join(dir, f)); } catch (_) { return []; }
}
const pack = () => [...files(BUILTIN_DIR), ...files(USER_DIR)];

const clampGap = (n) => Math.max(MIN_GAP, Math.min(MAX_GAP, Math.round(Number(n) || DEFAULT_GAP)));

/** Called by events/messages.js for every incoming (not-from-me) message. Never throws. */
async function maybeReact(sock, msg, prefix) {
  try {
    const jid = msg.key.remoteJid;
    if (!jid || jid === "status@broadcast" || msg.key.fromMe) return;
    const s = setup();
    const gap = s.chats[jid] || s.all;
    if (!gap) return;
    // do not answer commands, so they never get a sticker in between
    const body = (msg.message && (msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text))) || "";
    if (prefix && body.trim().startsWith(prefix)) return;
    const now = Date.now();
    if (now - (lastSent.get(jid) || 0) < gap * 1000) return;
    const list = pack();
    if (!list.length) return;
    lastSent.set(jid, now);
    const file = list[Math.floor(Math.random() * list.length)];
    await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 1200)));
    await sock.sendMessage(jid, { sticker: fs.readFileSync(file) }, { quoted: msg });
  } catch (e) {
    logger.error("[rs] " + e.message);
  }
}

module.exports = {
  name: "rs",
  aliases: ["reactsticker", "stickerreact"],
  description: "Automatic sticker reactions. Usage: .rs 30 | .rs off | .rs add | .rs list",
  maybeReact,
  async execute(sock, msg, args) {
    if (!isOwner(msg)) return;
    const jid = msg.key.remoteJid;
    const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg });
    const a0 = (args[0] || "").toLowerCase();
    const s = setup();

    if (!a0 || a0 === "list" || a0 === "status") {
      const n = pack().length;
      const here = s.chats[jid] ? "ON (" + s.chats[jid] + " s)" : "OFF";
      const all = s.all ? "ON (" + s.all + " s)" : "OFF";
      const chats = Object.keys(s.chats).length;
      return reply(
        "🎭 *RS · Sticker Reactions*\n\n" +
        "• This chat: " + here + "\n• All chats: " + all + "\n• Chats with RS on: " + chats + "\n• Stickers in pack: " + n + "\n\n" +
        "*.rs 30* → ON here (one sticker every 30 s max)\n*.rs off* → OFF here\n*.rs all 30* → ON everywhere\n*.rs alloff* → everything OFF\n" +
        "*.rs add* → reply to a sticker to save it\n*.rs clear* → delete the stickers you added" +
        (n ? "" : "\n\n⚠️ The pack is empty. Reply to a sticker with *.rs add* first.")
      );
    }

    if (a0 === "add") {
      const ctx = msg.message && msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo;
      const q = ctx && ctx.quotedMessage;
      if (!q || !q.stickerMessage) return reply("❌ Reply to a *sticker* with .rs add");
      try {
        const buf = await downloadMediaMessage(
          { key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant, fromMe: false }, message: q },
          "buffer", {}, { logger: silent, reuploadRequest: sock.updateMediaMessage }
        );
        fs.mkdirSync(USER_DIR, { recursive: true });
        fs.writeFileSync(path.join(USER_DIR, Date.now() + "_" + Math.floor(Math.random() * 1e4) + ".webp"), buf);
        return reply("✅ Sticker saved. Pack size: *" + pack().length + "*");
      } catch (e) { return reply("❌ Could not save it: " + e.message); }
    }

    if (a0 === "clear") {
      let n = 0;
      for (const f of files(USER_DIR)) { try { fs.unlinkSync(f); n++; } catch (_) {} }
      return reply("🗑️ Deleted *" + n + "* sticker(s) that you added.");
    }

    if (a0 === "off") { delete s.chats[jid]; save(s); return reply("🔴 RS is now *OFF* in this chat."); }
    if (a0 === "alloff") { s.all = 0; s.chats = {}; save(s); return reply("🔴 RS is now *OFF* everywhere."); }

    if (a0 === "all") {
      s.all = clampGap(args[1]); save(s);
      return reply("🟢 RS is *ON in every chat* · 1 sticker per chat every *" + s.all + " s*." + (pack().length ? "" : "\n⚠️ Pack is empty, use .rs add"));
    }

    // .rs 30   /   .rs on   /   .rs on 30
    if (a0 === "on" || /^\d+$/.test(a0)) {
      const gap = clampGap(a0 === "on" ? args[1] : a0);
      s.chats[jid] = gap; save(s);
      return reply("🟢 RS is *ON* in this chat · 1 sticker every *" + gap + " s* max." + (pack().length ? "" : "\n⚠️ Pack is empty, reply to a sticker with .rs add"));
    }
    return reply("Usage: .rs 30 | .rs off | .rs all 30 | .rs alloff | .rs add | .rs list | .rs clear");
  },
};
