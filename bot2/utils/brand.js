/**
 * Single place for the bot's branding. Change a value here and every
 * module that imports it (menu, channel forwarding, etc.) follows.
 */
const CHANNEL_INVITE = "0029VbE1PSOGzzKS8DCvLM32";

module.exports = {
  BOT_NAME: "MARCO X WAQAR MD",
  DEVELOPER: "Marco Malik",
  CO_OWNER: "WAQAR WRITES",
  TEAM: "Marco X Waqar",

  // ---- TEAM (shown in .owner, .developers and the welcome message) ----
  TEAM_MEMBERS: [
    { role: "Owner & Lead Developer", name: "Marco Malik", emoji: "👑" },
    { role: "Developer", name: "Kumail", emoji: "💻" },
    { role: "Developer", name: "Zahid King", emoji: "🤴" },
    { role: "Developer", name: "Syed Abdul Wahab Bukhari", emoji: "🛡️" },
    { role: "Developer", name: "Waqar Writes", emoji: "✍️" },
  ],
  TAGLINE: "Together for Better Experience",

  WEBSITE_URL: "https://marco-waqar-md-mini-bot-pairing.up.railway.app/pair",
  FOOTER: "Powered by Marco x Waqar MD",

  // WhatsApp channel
  CHANNEL_INVITE,
  CHANNEL_URL: `https://whatsapp.com/channel/${CHANNEL_INVITE}`,
  CHANNEL_NAME: "MARCO X WAQAR MD",

  // WhatsApp group
  GROUP_URL: "https://chat.whatsapp.com/IHulRNuqUf4H7Xkk5nQH9J?s=cl&p=a&iam=2",

  // Telegram bug bot
  BUG_BOT_URL: "https://t.me/MarcoXWqarBugBot",
};
