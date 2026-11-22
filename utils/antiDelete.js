"use strict";
/**
 * GROUP ANTI-DELETE (.gcantidelete on/off, per group)
 *
 * When it is ON for a group and somebody deletes a message (text, photo, video, voice note,
 * audio, sticker, document) the bot sends it again in the SAME group, with who sent it and
 * who deleted it.
 *
 * - remember(sock, msg)      called for every incoming message (cheap: does nothing for groups
 *                            where the feature is off)
 * - handleRevoke(sock, msg)  called when a delete-for-everyone event arrives
 * Media is saved to a temporary folder right when it arrives (WhatsApp removes it from its
 * servers after a delete), kept for a few hours and cleaned automatically.
 * View-once messages are never stored.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const baileys = require("@whiskeysockets/baileys");
const groupSettings = require("./groupSettingsStore");
const viewOnce = require("./viewOnce");

const DIR = path.join(os.tmpdir(), "gc-antidelete");
try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {}

const MAX_ENTRIES = 1200;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_DISK_BYTES = 250 * 1024 * 1024;
const MAX_MEDIA_BYTES = 30 * 1024 * 1024;

const store = new Map(); // `${jid}:${id}` -> entry
let diskBytes = 0;

const settingsStore = require("./settingsStore");
const groupOn = (jid) => !!groupSettings.get(jid, "gcantidelete", false);
const globalOn = () => settingsStore.get("antidelete", true) !== false;
const enabled = (jid) => (String(jid || "").endsWith("@g.us") && groupOn(jid)) || globalOn();
const numOf = (jid) => String(jid || "").split("@")[0].split(":")[0];

function drop(key) {
  const e = store.get(key);
  if (!e) return;
  if (e.file) { try { fs.unlinkSync(e.file); } catch (_) {} diskBytes -= e.size || 0; }
  store.delete(key);
}
function prune() {
  const now = Date.now();
  for (const [k, e] of store) if (now - e.ts > MAX_AGE_MS) drop(k);
  while ((store.size > MAX_ENTRIES || diskBytes > MAX_DISK_BYTES) && store.size) drop(store.keys().next().value);
}
setInterval(prune, 10 * 60 * 1000).unref();

function classify(content) {
  if (!content) return null;
  if (content.conversation) return { type: "text", text: content.conversation };
  if (content.extendedTextMessage && content.extendedTextMessage.text) return { type: "text", text: content.extendedTextMessage.text };
  if (content.imageMessage) return { type: "image", node: content.imageMessage, key: "imageMessage" };
  if (content.videoMessage) return { type: "video", node: content.videoMessage, key: "videoMessage" };
  if (content.audioMessage) return { type: "audio", node: content.audioMessage, key: "audioMessage" };
  if (content.stickerMessage) return { type: "sticker", node: content.stickerMessage, key: "stickerMessage" };
  if (content.documentMessage) return { type: "document", node: content.documentMessage, key: "documentMessage" };
  if (content.contactMessage) return { type: "text", text: "👤 Contact: " + (content.contactMessage.displayName || "") };
  if (content.locationMessage) return { type: "text", text: "📍 Location: https://maps.google.com/?q=" + content.locationMessage.degreesLatitude + "," + content.locationMessage.degreesLongitude };
  return null;
}

function remember(sock, msg) {
  try {
    const jid = msg && msg.key && msg.key.remoteJid;
    if (!jid || jid === "status@broadcast" || msg.key.fromMe || !msg.message) return;
    if (!enabled(jid)) return;
    const content = viewOnce.unwrapEphemeral(msg.message);
    if (!content || content.protocolMessage || content.reactionMessage) return;
    if (content.viewOnceMessage || content.viewOnceMessageV2 || content.viewOnceMessageV2Extension) return; // never store view-once
    const c = classify(content);
    if (!c) return;
    if (c.node && c.node.viewOnce) return;

    const key = jid + ":" + msg.key.id;
    const entry = { type: c.type, text: c.text || (c.node && c.node.caption) || "", sender: msg.key.participantPn || msg.key.participant || msg.participant || msg.key.remoteJidAlt || jid, chatJid: jid, ts: Date.now(),
      mimetype: c.node && c.node.mimetype, ptt: c.node && c.node.ptt, fileName: c.node && c.node.fileName, file: null, size: 0 };
    store.set(key, entry);
    prune();

    if (c.node) {
      const len = Number(c.node.fileLength || 0);
      if (len && len > MAX_MEDIA_BYTES) { entry.tooBig = true; return; }
      const wrapper = { key: msg.key, message: { [c.key]: c.node } };
      entry.pending = baileys.downloadMediaMessage(wrapper, "buffer", {}, { reuploadRequest: sock.updateMediaMessage })
        .then((buf) => {
          if (!buf || !buf.length || !store.has(key)) return;
          const file = path.join(DIR, Buffer.from(key).toString("hex").slice(0, 60) + "_" + Date.now());
          fs.writeFileSync(file, buf);
          entry.file = file; entry.size = buf.length; diskBytes += buf.length;
          prune();
        })
        .catch((e) => console.error("[gc-antidelete] could not save media:", e && e.message))
        .finally(() => { entry.pending = null; });
    }
  } catch (e) { console.error("[gc-antidelete] remember:", e && e.message); }
}

async function displayNumber(sock, groupJid, jid) {
  if (!jid) return "someone";
  if (/@s\.whatsapp\.net$/.test(jid)) return numOf(jid);
  try {
    const meta = await sock.groupMetadata(groupJid);
    const p = (meta.participants || []).find((x) => x.id === jid || x.lid === jid);
    const real = p && (p.phoneNumber || (p.id && /@s\.whatsapp\.net$/.test(p.id) ? p.id : null));
    if (real) return numOf(real);
  } catch (_) {}
  return numOf(jid);
}

/** @returns {Promise<boolean>} true when this module handled (or intentionally ignored) the delete event */
async function handleRevoke(sock, msg) {
  const jid = msg && msg.key && msg.key.remoteJid;
  if (!jid || jid === "status@broadcast" || !enabled(jid)) return false;
  const pm = viewOnce.unwrapEphemeral(msg.message || {}).protocolMessage;
  if (!pm || !pm.key || !pm.key.id) return false;
  if (msg.key.fromMe) return true; // the bot owner deleted it themselves

  const key = jid + ":" + pm.key.id;
  const e = store.get(key);
  if (!e) return true; // not seen by the bot (older than the feature) - nothing to resend
  if (e.pending) await Promise.race([e.pending, new Promise((r) => setTimeout(r, 8000))]);

  const isGroup = jid.endsWith("@g.us");
  let dest = jid;
  if (!(isGroup && groupOn(jid)) && settingsStore.get("antideleteDest", "p") !== "g") {
    try { if (sock.user && sock.user.id) dest = baileys.jidNormalizedUser(sock.user.id); } catch (_) {}
  }
  const deleter = msg.key.participant || pm.key.participant || e.sender;
  const senderNum = await displayNumber(sock, jid, e.sender);
  const deleterNum = await displayNumber(sock, jid, deleter);
  const mentions = [...new Set([e.sender, deleter].filter(Boolean))];
  const time = new Date(e.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  const head =
    "🗑️ *ANTI-DELETE*\n" +
    "👤 *Sent by:* @" + senderNum + "\n" +
    (deleter && deleter !== e.sender ? "🧹 *Deleted by:* @" + deleterNum + "\n" : "") +
    "🕒 *Time:* " + time + "\n" +
    "📍 *Chat:* " + (isGroup ? "group" : "+" + numOf(e.chatJid === jid && e.sender ? e.sender : jid)) + "\n" +
    "━━━━━━━━━━━━━━";
  const tail = "\n\n> _Powered by Marco x Waqar MD_";

  try {
    if (e.type === "text") {
      await sock.sendMessage(dest, { text: head + "\n\n" + e.text + tail, mentions });
    } else {
      let buf = null;
      if (e.file) { try { buf = fs.readFileSync(e.file); } catch (_) {} }
      if (!buf) {
        await sock.sendMessage(dest, { text: head + "\n\n_(a " + e.type + " was deleted but it could not be recovered" + (e.tooBig ? ": file too large" : "") + ")_" + tail, mentions });
      } else if (e.type === "image") {
        await sock.sendMessage(dest, { image: buf, caption: head + (e.text ? "\n\n" + e.text : "") + tail, mentions });
      } else if (e.type === "video") {
        await sock.sendMessage(dest, { video: buf, caption: head + (e.text ? "\n\n" + e.text : "") + tail, mentions });
      } else if (e.type === "audio") {
        await sock.sendMessage(dest, { text: head + "\n🎙️ _" + (e.ptt ? "voice note" : "audio") + " below_" + tail, mentions });
        await sock.sendMessage(dest, { audio: buf, mimetype: e.mimetype || "audio/ogg; codecs=opus", ptt: !!e.ptt });
      } else if (e.type === "sticker") {
        await sock.sendMessage(dest, { text: head + "\n🖼️ _sticker below_" + tail, mentions });
        await sock.sendMessage(dest, { sticker: buf });
      } else if (e.type === "document") {
        await sock.sendMessage(dest, { text: head + "\n📄 _document below_" + tail, mentions });
        await sock.sendMessage(dest, { document: buf, mimetype: e.mimetype || "application/octet-stream", fileName: e.fileName || "file" });
      }
    }
  } catch (err) {
    console.error("[gc-antidelete] resend failed:", err && err.message);
  }
  drop(key);
  return true;
}

module.exports = { remember, handleRevoke, enabled };
