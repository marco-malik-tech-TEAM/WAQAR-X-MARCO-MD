"use strict";
/** .welcome / .goodbye / .setwelcome / .setgoodbye  (per group, owner / sudo / group admin) */
const groupSettings = require("./groupSettingsStore");
const { isOwner } = require("./isOwner");
const { isSudo } = require("./isSudo");
const { isSenderAdmin } = require("./isAdmin");

async function allowed(sock, msg) {
  if (isOwner(msg) || isSudo(msg)) return true;
  try {
    const meta = await sock.groupMetadata(msg.key.remoteJid);
    return isSenderAdmin(meta, msg.key.participant || msg.participant);
  } catch (_) { return false; }
}

function toggle(kind, label) {
  return {
    name: kind,
    description: `Turn ${label} messages on/off in this group. Usage: .${kind} on/off`,
    async execute(sock, msg, args) {
      const jid = msg.key.remoteJid;
      const say = (t) => sock.sendMessage(jid, { text: t }, { quoted: msg });
      if (!jid.endsWith("@g.us")) return say("❌ This command only works in groups.");
      if (!(await allowed(sock, msg))) return say("❌ Only the bot owner or a group admin can use this command.");
      const a = String((args && args[0]) || "").toLowerCase();
      if (a === "on" || a === "off") {
        groupSettings.set(jid, kind, a === "on");
        return say(`${kind === "welcome" ? "🎉" : "👋"} *${label.toUpperCase()} messages: ${a === "on" ? "ON 🟢" : "OFF 🔴"}*\n\nTip: customise the text with *.set${kind} <your text>*\nYou can use: @user  {group}  {count}  {desc}`);
      }
      const now = groupSettings.get(jid, kind, false);
      return say(`${kind === "welcome" ? "🎉" : "👋"} *${label}:* ${now ? "ON 🟢" : "OFF 🔴"}\n\nUsage:\n• .${kind} on\n• .${kind} off\n• .set${kind} <text>  (use @user {group} {count} {desc})\n• .set${kind} reset`);
    },
  };
}
function setText(kind, label) {
  const key = kind + "Text";
  return {
    name: "set" + kind,
    description: `Set a custom ${label} text. Usage: .set${kind} Hello @user, welcome to {group}`,
    async execute(sock, msg, args) {
      const jid = msg.key.remoteJid;
      const say = (t) => sock.sendMessage(jid, { text: t }, { quoted: msg });
      if (!jid.endsWith("@g.us")) return say("❌ This command only works in groups.");
      if (!(await allowed(sock, msg))) return say("❌ Only the bot owner or a group admin can use this command.");
      const text = (args || []).join(" ").trim();
      if (!text) return say(`✍️ Usage: .set${kind} <text>\nPlaceholders: @user  {group}  {count}  {desc}\nReset: .set${kind} reset`);
      if (text.toLowerCase() === "reset") { groupSettings.set(jid, key, ""); return say(`♻️ ${label} text reset to the default.`); }
      groupSettings.set(jid, key, text.slice(0, 900));
      groupSettings.set(jid, kind, true);
      return say(`✅ ${label} text saved and ${kind} turned *ON*.`);
    },
  };
}
module.exports = [toggle("welcome", "Welcome"), toggle("goodbye", "Goodbye"), setText("welcome", "Welcome"), setText("goodbye", "Goodbye")];
