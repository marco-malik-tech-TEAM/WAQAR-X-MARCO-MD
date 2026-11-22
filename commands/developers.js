const brand = require("../utils/brand");
const fs = require("fs");
const path = require("path");

function card() {
  const m = brand.TEAM_MEMBERS || [];
  const lines = m.map((x, i) =>
    (i === 0 ? "┃ " : "┃ ") + x.emoji + " *" + x.name + "*\n┃     ┗ ✨ _" + x.role + "_").join("\n┃\n");
  return (
    "╔═══════════════════╗\n" +
    "   🌟 *" + brand.BOT_NAME + "* 🌟\n" +
    "╚═══════════════════╝\n\n" +
    "┏━━━〔 💎 *OUR TEAM* 💎 〕━━━┓\n┃\n" +
    lines +
    "\n┃\n┗━━━━━━━━━━━━━━━━━━━┛\n\n" +
    "🔥 _Professional • Powerful • Always Online_\n" +
    "💬 _" + brand.TAGLINE + "_\n\n" +
    "📢 *Channel:* " + brand.CHANNEL_URL + "\n" +
    "🌐 *Website:* " + brand.WEBSITE_URL + "\n\n" +
    "_" + brand.FOOTER + "_"
  );
}

module.exports = {
  name: "developers",
  aliases: ["devs", "team", "ourteam", "creators", "teaminfo"],
  description: "Shows the owner and the developer team.",
  async execute(sock, msg) {
    const chat = msg.key.remoteJid;
    const text = card();
    const dp = [path.join(__dirname, "../web/dp.jpg"), path.join(__dirname, "../assets/thumb.jpg")].find((f) => fs.existsSync(f));
    try {
      if (dp) return await sock.sendMessage(chat, { image: fs.readFileSync(dp), caption: text }, { quoted: msg });
    } catch (_) {}
    await sock.sendMessage(chat, { text }, { quoted: msg });
  },
  card,
};
