"use strict";
/** Sends the welcome / goodbye card + message when members join or leave a group. */
const { buildCard } = require("./welcomeCard");
const brand = require("./brand");

const numOf = (jid) => String(jid || "").split("@")[0].split(":")[0];
const TZ = process.env.TIMEZONE || "Asia/Karachi";

function stamp() {
  try {
    const d = new Date();
    return {
      date: d.toLocaleDateString("en-GB", { timeZone: TZ, day: "2-digit", month: "short", year: "numeric" }),
      time: d.toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }),
    };
  } catch (_) { return { date: "", time: "" }; }
}
function fill(text, v) {
  return String(text).replace(/@user/gi, v.tag).replace(/\{group\}/gi, v.group).replace(/\{count\}/gi, String(v.count)).replace(/\{desc\}/gi, v.desc);
}

async function realNumber(sock, groupJid, p) {
  // new WhatsApp accounts appear as @lid - find the real phone number when possible
  const id = (p && (p.phoneNumber || p.id)) || p;
  if (/@s\.whatsapp\.net$/.test(String(id))) return { jid: id, num: numOf(id) };
  try {
    const meta = await sock.groupMetadata(groupJid);
    const m = (meta.participants || []).find((x) => x.id === id || x.lid === id);
    const phone = m && m.phoneNumber;
    if (phone) return { jid: id, num: numOf(phone) };
  } catch (_) {}
  return { jid: id, num: numOf(id) };
}

async function handle(sock, update, meta, groupSettings) {
  const groupJid = update.id;
  const groupName = (meta && meta.subject) || "the group";
  const count = (meta && meta.participants && meta.participants.length) || "";
  const desc = ((meta && meta.desc) || "").toString().trim().slice(0, 220);
  const botIds = new Set([sock.user && sock.user.id, sock.user && sock.user.lid].filter(Boolean).map(numOf));
  const { date, time } = stamp();

  for (const p of update.participants || []) {
    const { jid, num } = await realNumber(sock, groupJid, p);
    if (botIds.has(num) || botIds.has(numOf(jid))) continue; // never greet the bot itself
    let type = null;
    if (update.action === "add" && groupSettings.welcome) type = "welcome";
    else if (update.action === "remove" && groupSettings.goodbye) type = "goodbye";
    if (!type) continue;

    const v = { tag: "@" + numOf(jid), group: groupName, count, desc: desc || "No description" };
    const custom = type === "welcome" ? groupSettings.welcomeText : groupSettings.goodbyeText;
    const caption = custom && String(custom).trim()
      ? fill(custom, v) + "\n\n> _" + brand.FOOTER + "_"
      : type === "welcome"
        ? `╔═══════════════╗\n   🎉 *WELCOME* 🎉\n╚═══════════════╝\n\nHey ${v.tag}! 👋\nWelcome to *${groupName}* 🌟\n\n👥 You are member *#${count}*\n📅 ${date} • 🕒 ${time}\n` +
          (desc ? `\n📜 *About the group:*\n${desc}\n` : "") +
          `\n💬 Introduce yourself\n✅ Follow the group rules\n🎉 Enjoy your stay!\n\n> _${brand.FOOTER}_`
        : `╔═══════════════╗\n   👋 *GOODBYE* 👋\n╚═══════════════╝\n\n${v.tag} has left *${groupName}*.\n\n👥 Members now: *${count}*\n📅 ${date} • 🕒 ${time}\n\nWe wish you all the best! 🌹\n\n> _${brand.FOOTER}_`;

    let card = null;
    try { card = await buildCard({ sock, jid, number: num, groupName, memberCount: count, type }); } catch (_) {}
    try {
      if (card) await sock.sendMessage(groupJid, { image: card, caption, mentions: [jid] });
      else await sock.sendMessage(groupJid, { text: caption, mentions: [jid] });
    } catch (e) {
      console.error("[welcomeGreeter] send failed:", e.message);
      try { await sock.sendMessage(groupJid, { text: caption, mentions: [jid] }); } catch (_) {}
    }
  }
}

module.exports = { handle };
