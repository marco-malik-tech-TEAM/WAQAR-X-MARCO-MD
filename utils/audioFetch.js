"use strict";
/**
 * Robust YouTube audio for .play / .play2 / .song / .audio
 *
 * 1. Search with yt-search (local, no third-party API), Keith API as fallback.
 * 2. Get the audio from several download APIs at the same time (first valid one wins).
 * 3. If every API is down (503, 403, rate limit ...) fall back to a local yt-dlp + ffmpeg mp3.
 * 4. The audio is downloaded INSIDE the bot and sent as a buffer, so a bad link can never
 *    silently break the message.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const yts = require("yt-search");
const { KEITH_BASE } = require("../config/apis");

const UA = { "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36" };
const YT_ID = /(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/;
const MAX_AUDIO_BYTES = 95 * 1024 * 1024;
const MAX_SECONDS = 70 * 60;

const isHttp = (u) => typeof u === "string" && /^https?:\/\//i.test(u);
const isYouTube = (u) => /(?:youtube\.com|youtu\.be)/i.test(String(u || ""));
const clean = (s) => String(s || "audio").replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 90) || "audio";

// ---------------- search ----------------
async function search(query) {
  query = String(query || "").trim();
  if (isYouTube(query)) {
    const id = (query.match(YT_ID) || [])[1];
    if (id) {
      try {
        const v = await yts({ videoId: id });
        if (v) return meta(v, "https://www.youtube.com/watch?v=" + id);
      } catch (_) {}
      return { url: "https://www.youtube.com/watch?v=" + id, title: "YouTube Audio", videoId: id };
    }
  }
  try {
    const r = await yts(query);
    const v = r && r.videos && r.videos[0];
    if (v) return meta(v, v.url);
  } catch (e) { console.error("[AUDIO] yt-search failed:", e.message); }
  try {
    const r = await axios.get(KEITH_BASE + "/search/yts?query=" + encodeURIComponent(query), { timeout: 15000, headers: UA });
    const list = r.data && r.data.result;
    const v = Array.isArray(list) && list.find((x) => x && isYouTube(x.url));
    if (v) return { url: v.url, title: v.title || "YouTube Audio", thumbnail: v.thumbnail || v.image, duration: v.duration, author: v.channel || v.author };
  } catch (e) { console.error("[AUDIO] keith search failed:", e.message); }
  return null;
}
function meta(v, url) {
  return {
    url, title: v.title || "YouTube Audio", thumbnail: v.thumbnail || v.image || null,
    duration: v.timestamp || (v.duration && v.duration.timestamp) || null,
    seconds: v.seconds || (v.duration && v.duration.seconds) || 0,
    author: (v.author && v.author.name) || null, views: v.views || null, ago: v.ago || null, videoId: v.videoId || null,
  };
}

// ---------------- link finders ----------------
function collect(node, out, p = "") {
  if (!node) return;
  if (typeof node === "string") { if (isHttp(node)) out.push({ url: node, p }); return; }
  if (Array.isArray(node)) return node.forEach((n, i) => collect(n, out, p + "." + i));
  if (typeof node === "object") for (const k of Object.keys(node)) collect(node[k], out, p + "." + k);
}
function pickAudioLink(body) {
  const list = [];
  collect(body, list);
  const bad = /thumb|image|jpg|jpeg|png|webp|avatar|\.vtt|subtitle/i;
  const score = (c) => (/mp3|audio|download|direct|dl|url|link/i.test(c.p) ? 2 : 0) + (/\.mp3|\.m4a|audio|mime=audio|googlevideo/i.test(c.url) ? 3 : 0);
  const ok = list.filter((c) => !bad.test(c.url) && !/youtube\.com\/watch|youtu\.be\//i.test(c.url));
  ok.sort((a, b) => score(b) - score(a));
  return ok[0] ? ok[0].url : null;
}

const SOURCES = [
  { name: "Keith", get: (u) => KEITH_BASE + "/download/audio?url=" + encodeURIComponent(u) },
  { name: "Keith-mp3", get: (u) => KEITH_BASE + "/download/ytmp3?url=" + encodeURIComponent(u) },
  { name: "Siputzx", get: (u) => "https://api.siputzx.my.id/api/d/ytmp3?url=" + encodeURIComponent(u) },
  { name: "Vreden", get: (u) => "https://api.vreden.my.id/api/ytmp3?url=" + encodeURIComponent(u) },
  { name: "Ryzen", get: (u) => "https://api.ryzendesu.vip/api/downloader/ytmp3?url=" + encodeURIComponent(u) },
];

async function fetchBuffer(url) {
  const r = await axios.get(url, {
    responseType: "arraybuffer", timeout: 120000, maxRedirects: 8, headers: UA,
    maxContentLength: MAX_AUDIO_BYTES, maxBodyLength: MAX_AUDIO_BYTES,
    validateStatus: (s) => s >= 200 && s < 300,
  });
  const buf = Buffer.from(r.data);
  const type = String(r.headers["content-type"] || "");
  if (buf.length < 20 * 1024 || /text\/html|application\/json/i.test(type)) throw new Error("source returned no audio");
  return buf;
}

async function viaApis(videoUrl) {
  return new Promise((resolve, reject) => {
    let pending = SOURCES.length, done = false;
    const errs = [];
    const fail = (name, e) => {
      const st = e && e.response && e.response.status;
      errs.push(name + ": " + (st ? "HTTP " + st : (e && e.message) || "failed"));
      if (--pending === 0 && !done) reject(new Error(errs.join(" | ")));
    };
    for (const s of SOURCES) {
      (async () => {
        const r = await axios.get(s.get(videoUrl), { timeout: 25000, headers: UA });
        const link = pickAudioLink(r.data);
        if (!link) throw new Error("no audio link");
        const buf = await fetchBuffer(link);
        if (!done) { done = true; resolve({ buffer: buf, via: s.name }); }
      })().catch((e) => fail(s.name, e));
    }
  });
}

async function viaYtDlp(videoUrl) {
  const ytdlp = require("./ytdlp");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aud-"));
  try {
    const file = await ytdlp.downloadAudio(videoUrl, { dir });
    return { buffer: fs.readFileSync(file), via: "yt-dlp", ext: path.extname(file).slice(1).toLowerCase() };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
}

async function getAudio(videoUrl) {
  const errors = [];
  try { return await viaApis(videoUrl); } catch (e) { errors.push(e.message); }
  try { return await viaYtDlp(videoUrl); } catch (e) { errors.push("yt-dlp: " + e.message); }
  const err = new Error("All download sources failed right now. Please try again in a minute.");
  err.details = errors.join(" || ");
  throw err;
}

// ---------------- chat command runner ----------------
const mimeFor = (ext) => (ext === "m4a" || ext === "aac" ? "audio/mp4" : ext === "webm" || ext === "opus" || ext === "ogg" ? "audio/ogg; codecs=opus" : "audio/mpeg");

/**
 * mode: "play"  -> info card + audio
 *       "song"  -> audio only
 *       "play2" -> audio + mp3 file (document)
 */
async function run(sock, msg, query, mode, usage) {
  const jid = msg.key.remoteJid;
  query = String(query || "").trim();
  if (!query) return sock.sendMessage(jid, { text: usage }, { quoted: msg });

  let status;
  const edit = async (text) => {
    try { if (status) await sock.sendMessage(jid, { text, edit: status.key }); else status = await sock.sendMessage(jid, { text }, { quoted: msg }); }
    catch (_) {}
  };
  try {
    await edit('🔍 *Searching* "' + query.slice(0, 80) + '" ...');
    const info = await search(query);
    if (!info) return edit("❌ No results found. Try another name or paste the YouTube link.");
    if (info.seconds && info.seconds > MAX_SECONDS) return edit("❌ This video is too long (over 70 minutes).");

    if (mode === "play") {
      const lines = ["🎧 *" + info.title + "*", ""];
      if (info.author) lines.push("👤 " + info.author);
      if (info.duration) lines.push("⏱ " + info.duration);
      if (info.views) lines.push("👁 " + Number(info.views).toLocaleString("en-US") + " views");
      if (info.ago) lines.push("📅 " + info.ago);
      lines.push("", "⬇️ _Downloading audio, please wait..._", "", "> _Powered by Marco x Waqar MD_");
      let sent = false;
      if (info.thumbnail) {
        try { await sock.sendMessage(jid, { image: { url: info.thumbnail }, caption: lines.join("\n") }, { quoted: msg }); sent = true; } catch (_) {}
      }
      if (!sent) await edit(lines.join("\n"));
    } else {
      await edit("🎧 *Downloading...*\n\n" + info.title);
    }

    const audio = await getAudio(info.url);
    const ext = audio.ext || "mp3";
    const fileName = clean(info.title) + "." + (ext === "mp3" ? "mp3" : ext);
    await sock.sendMessage(jid, { audio: audio.buffer, mimetype: mimeFor(ext), fileName, ptt: false }, { quoted: msg });
    if (mode === "play2") {
      await sock.sendMessage(jid, { document: audio.buffer, mimetype: mimeFor(ext), fileName }, { quoted: msg });
    }
    if (status) await edit("✅ *Done*\n\n🎵 " + info.title);
    console.log("[AUDIO] sent via " + audio.via + " : " + info.title);
  } catch (e) {
    console.error("[AUDIO ERROR]", e.message, e.details || "");
    await edit("❌ *Could not download this song.*\n\n" + (e.message || "Unknown error") + "\n\n💡 Try again in a minute, or use another name / link.");
  }
}

module.exports = { run, search, getAudio, clean };
