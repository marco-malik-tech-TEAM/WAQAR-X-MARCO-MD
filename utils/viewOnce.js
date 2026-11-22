"use strict";
/**
 * View-once helper used by .vv and .vv2
 *
 * - remember(msg): keeps the raw view-once messages the bot receives (small, in memory, last 300),
 *   because WhatsApp often strips the media key from the QUOTED copy of a view-once message.
 * - extract(sock, msg): finds the quoted view-once media and downloads it, trying
 *   (1) the original message the bot received, (2) the quoted copy, with re-upload request.
 * - unwrapEphemeral(message): disappearing-message groups wrap every message; this unwraps them
 *   so commands (like .vv) work in those groups too.
 */
const baileys = require("@whiskeysockets/baileys");
const { downloadMediaMessage } = baileys;

const LIMIT = 300;
const seen = new Map(); // `${jid}:${id}` -> raw message object

function unwrapEphemeral(m) {
  let guard = 0;
  while (m && guard++ < 5) {
    if (m.ephemeralMessage && m.ephemeralMessage.message) m = m.ephemeralMessage.message;
    else if (m.documentWithCaptionMessage && m.documentWithCaptionMessage.message) m = m.documentWithCaptionMessage.message;
    else break;
  }
  return m;
}

function viewOnceInner(m) {
  m = unwrapEphemeral(m);
  if (!m) return null;
  const w = m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension;
  if (w && w.message) return w.message;
  for (const k of ["imageMessage", "videoMessage", "audioMessage"]) if (m[k] && m[k].viewOnce) return m;
  return null;
}

const buffers = new Map(); // `${jid}:${id}` -> { type, buffer, caption, mimetype, ptt, seconds }
let bufBytes = 0;
const MAX_BUF_TOTAL = 150 * 1024 * 1024;
const MAX_BUF_ONE = 40 * 1024 * 1024;

function putBuffer(k, v) {
  buffers.set(k, v);
  bufBytes += v.buffer.length;
  while ((buffers.size > 60 || bufBytes > MAX_BUF_TOTAL) && buffers.size) {
    const first = buffers.keys().next().value;
    bufBytes -= buffers.get(first).buffer.length;
    buffers.delete(first);
  }
}

/**
 * Called for every incoming message. A view-once message is downloaded IMMEDIATELY (while WhatsApp
 * still allows it) and kept in memory, so .vv works later and, with auto-open ON (default), the
 * media is sent straight to the bot's own chat as a normal photo / video / voice note.
 */
function remember(msg, sock) {
  try {
    if (!msg || !msg.message || !msg.key || !msg.key.id) return;
    if (!viewOnceInner(msg.message)) return;
    const k = msg.key.remoteJid + ":" + msg.key.id;
    seen.set(k, { key: msg.key, message: msg.message });
    while (seen.size > LIMIT) seen.delete(seen.keys().next().value);
    if (!sock || msg.key.fromMe) return;

    const media = pickMedia(msg.message);
    if (!media) return;
    (async () => {
      let buffer = null, lastErr = "";
      for (let i = 0; i < 3 && !buffer; i++) {
        try { buffer = await tryDownload(sock, { key: msg.key, message: msg.message }); }
        catch (e) { lastErr = e && e.message ? e.message : String(e); await new Promise((r) => setTimeout(r, 800)); }
      }
      if (!buffer || !buffer.length) { console.error("[vv-auto] could not download:", lastErr); return; }
      if (buffer.length > MAX_BUF_ONE) return;
      const rec = { type: media.type, buffer, caption: media.node.caption || "", mimetype: media.node.mimetype, ptt: media.node.ptt, seconds: media.node.seconds };
      putBuffer(k, rec);

      let auto = true;
      try { auto = require("./settingsStore").get("autovv", true) !== false; } catch (_) {}
      if (!auto) return;
      const me = sock.user && sock.user.id ? baileys.jidNormalizedUser(sock.user.id) : null;
      if (!me) return;
      const from = String(msg.key.participantPn || msg.key.participantAlt || msg.key.participant || msg.key.remoteJidAlt || msg.key.remoteJid || "").split("@")[0].split(":")[0];
      const where = String(msg.key.remoteJid || "").endsWith("@g.us") ? "group" : "private chat";
      const head = "👁️ *VIEW-ONCE OPENED*\n👤 *From:* +" + from + "\n📍 *Chat:* " + where + (rec.caption ? "\n\n" + rec.caption : "");
      try {
        if (rec.type === "audio") {
          await sock.sendMessage(me, { text: head });
          await sock.sendMessage(me, toPayload(rec, ""));
        } else {
          await sock.sendMessage(me, toPayload(rec, head));
        }
      } catch (e) { console.error("[vv-auto] send failed:", e && e.message); }
    })();
  } catch (_) {}
}

function pickMedia(m) {
  const inner = viewOnceInner(m) || unwrapEphemeral(m) || {};
  if (inner.imageMessage) return { type: "image", node: inner.imageMessage };
  if (inner.videoMessage) return { type: "video", node: inner.videoMessage };
  if (inner.audioMessage) return { type: "audio", node: inner.audioMessage };
  return null;
}

function contextOf(msg) {
  const m = unwrapEphemeral(msg.message) || {};
  for (const k of Object.keys(m)) if (m[k] && typeof m[k] === "object" && m[k].contextInfo) return m[k].contextInfo;
  return null;
}

const reupload = (sock) => ({ reuploadRequest: sock.updateMediaMessage });

async function tryDownload(sock, wrapper) {
  return downloadMediaMessage(wrapper, "buffer", {}, reupload(sock));
}

/**
 * @returns {Promise<{ok:true,type,buffer,caption,mimetype,ptt}|{ok:false,reason:string,text:string}>}
 */
async function extract(sock, msg) {
  const ctx = contextOf(msg);
  if (!ctx || !ctx.quotedMessage)
    return { ok: false, reason: "noquote", text: "❌ Reply to a view-once photo, video or voice note with *.vv*" };

  const quoted = ctx.quotedMessage;
  const media = pickMedia(quoted);
  if (!media) return { ok: false, reason: "notmedia", text: "⚠️ That message is not a photo, video or voice note. Reply to a *view-once* message." };

  const chat = msg.key.remoteJid;
  const buffered = ctx.stanzaId ? buffers.get(chat + ":" + ctx.stanzaId) : null;
  if (buffered) return { ok: true, ...buffered };
  const attempts = [];
  const cached = ctx.stanzaId ? seen.get(chat + ":" + ctx.stanzaId) : null;
  if (cached) {
    const cm = pickMedia(cached.message);
    if (cm) attempts.push({ label: "original", media: cm, wrapper: { key: cached.key, message: cached.message } });
  }
  attempts.push({
    label: "quoted", media,
    wrapper: { key: { remoteJid: chat, id: ctx.stanzaId || "x", fromMe: false, participant: ctx.participant }, message: { [media.type + "Message"]: media.node } },
  });

  let lastErr = "";
  for (const a of attempts) {
    try {
      const buffer = await tryDownload(sock, a.wrapper);
      if (buffer && buffer.length) {
        return { ok: true, type: a.media.type, buffer, caption: a.media.node.caption || "", mimetype: a.media.node.mimetype, ptt: a.media.node.ptt, seconds: a.media.node.seconds };
      }
    } catch (e) { lastErr = e && e.message ? e.message : String(e); }
  }
  console.error("[vv] download failed:", lastErr);
  return {
    ok: false, reason: "download",
    text: "❌ Could not open this view-once media.\n\nThe bot did not receive this message while it was online (or it was already opened on the phone). From now on every view-once that arrives while the bot is online is opened automatically and sent to this chat." + (lastErr ? "\n\n_" + lastErr.slice(0, 120) + "_" : ""),
  };
}

function toPayload(r, caption) {
  const cap = caption || r.caption || "";
  if (r.type === "image") return { image: r.buffer, caption: cap };
  if (r.type === "video") return { video: r.buffer, caption: cap };
  return { audio: r.buffer, mimetype: r.mimetype || "audio/ogg; codecs=opus", ptt: r.ptt !== false };
}

module.exports = { remember, extract, toPayload, unwrapEphemeral };
