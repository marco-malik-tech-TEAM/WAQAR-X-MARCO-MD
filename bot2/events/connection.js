const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const {
  DisconnectReason,
  jidNormalizedUser,
} = require("@whiskeysockets/baileys");
const config = require("../config/config");
const logger = require("../utils/logger");
const { autoJoinGroupOnce } = require("../utils/autoJoin");
const brand = require("../utils/brand");
const channel = require("../utils/channel");

/**
 * Registers the connection update listener on the given socket.
 *
 * @param {object} sock - the Baileys socket instance
 * @param {Function} startBot - reference to the bot startup function,
 *                              used to reconnect automatically when needed
 */
// ---- shared reconnect state (survives socket re-creation) ----
let retries = 0;
let reconnectTimer = null;
let replacedHits = [];
let watchdog = null;
let lastOpenAt = 0;

function scheduleReconnect(startBot, reason, minDelay = 0) {
  if (reconnectTimer) return; // one reconnect at a time
  const backoff = Math.min(60000, 2000 * Math.pow(2, Math.min(retries, 5)));
  const delay = Math.max(minDelay, backoff);
  retries++;
  logger.warn(`🔁 ${reason} - reconnecting in ${Math.round(delay / 1000)}s (attempt ${retries})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    Promise.resolve()
      .then(() => startBot())
      .catch((e) => {
        logger.error("[reconnect] startBot failed: " + e.message);
        scheduleReconnect(startBot, "start failed");
      });
  }, delay);
}

function wsIsOpen(sock) {
  try {
    const ws = sock && sock.ws;
    if (!ws) return false;
    if (typeof ws.isOpen === "boolean") return ws.isOpen;
    if (typeof ws.readyState === "number") return ws.readyState === 1;
  } catch (_) {}
  return true; // unknown -> do not interfere
}

/**
 * Registers the connection update listener on the given socket.
 * 24/7 rules:
 *  - the process NEVER exits because of a dropped connection (only a real logout stops the bot)
 *  - every drop is retried with a growing back-off, forever
 *  - a watchdog re-creates the socket if the connection silently dies
 *  - the "started running" messages are sent only once, right after a fresh pairing
 */
function registerConnectionHandler(sock, startBot, wasAlreadyRegistered) {
  // Auto-follow + auto-react for the official WhatsApp channel.
  channel.attach(sock);

  // watchdog: if the socket is dead (and no reconnect is pending) for 3 minutes, rebuild it
  if (watchdog) clearInterval(watchdog);
  let deadSince = 0;
  watchdog = setInterval(() => {
    if (reconnectTimer) return;
    if (wsIsOpen(sock)) { deadSince = 0; return; }
    deadSince = deadSince || Date.now();
    if (Date.now() - deadSince > 3 * 60 * 1000) {
      deadSince = 0;
      scheduleReconnect(startBot, "watchdog: connection is dead", 1000);
    }
  }, 30 * 1000);
  watchdog.unref && watchdog.unref();

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info("Scan the QR code below with WhatsApp to log in:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "connecting") {
      logger.info("Connecting to WhatsApp...");
    }

    if (connection === "open") {
      logger.info("✅ Connected to WhatsApp successfully!");
      retries = 0;
      replacedHits = [];
      lastOpenAt = Date.now();
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

      try {
        const { groupCache } = require("../utils/groupCache");
        try {
          const allGroups = await sock.groupFetchAllParticipating();
          for (const [groupJid, metadata] of Object.entries(allGroups)) {
            groupCache.set(groupJid, metadata);
          }
          logger.info(
            `✅ Warmed group metadata cache for ${Object.keys(allGroups).length} group(s).`,
          );
        } catch (error) {
          logger.error(
            `[groupCache] Failed to warm cache on connect: ${error.message}`,
          );
        }

        await autoJoinGroupOnce(sock);

        const selfJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;

        if (!selfJid) {
          logger.warn("[connection] sock.user not available yet - skipping the startup message this time.");
        } else {
          // Send the welcome ONCE per linked number. A marker file remembers it, so reconnects and
          // restarts stay silent, but the first connection after pairing always gets the welcome
          // (WhatsApp restarts the socket right after pairing, which used to hide the welcome).
          const markerDir = path.join(require("../utils/paths").ROOT, "auth_info_baileys");
          const marker = path.join(markerDir, ".welcome_sent");
          if (!fs.existsSync(marker)) {
            try { fs.mkdirSync(markerDir, { recursive: true }); fs.writeFileSync(marker, String(Date.now())); } catch (_) {}
            await new Promise((r) => setTimeout(r, 2500));
            const send = async (content) => {
              for (let i = 0; i < 3; i++) {
                try { await sock.sendMessage(selfJid, content); return true; }
                catch (err) { logger.error("Welcome message failed (try " + (i + 1) + "): " + (err && err.message)); await new Promise((r) => setTimeout(r, 2000)); }
              }
              return false;
            };
            const team = (brand.TEAM_MEMBERS || []).map((x) => `${x.emoji} *${x.name}* — _${x.role}_`).join("\n");
            await send({
              text:
                `╔═══════════════════╗\n   🌟 *${brand.BOT_NAME}* 🌟\n╚═══════════════════╝\n\n` +
                `✅ *Connected successfully!*\n` +
                `🤖 Your bot is now running on your WhatsApp 24/7.\n\n` +
                `📜 Send *.menu* to see all commands\n👑 Send *.developers* to meet the team\n\n` +
                `💎 *OUR TEAM*\n${team}\n\n` +
                `📢 *Channel:* ${brand.CHANNEL_URL}\n🌐 *Website:* ${brand.WEBSITE_URL}\n\n_${brand.FOOTER}_`,
            });
            // Fresh pairing: reset the message-cutoff marker used by events/messages.js
            try { fs.unlinkSync(path.join(markerDir, ".first_boot_cutoff")); } catch {}
          }
        }
      } catch (error) {
        logger.error(`[connection open] Failed during post-connect steps: ${error.message}`);
      }
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      switch (statusCode) {
        case DisconnectReason.loggedOut:
          // The ONLY case where the bot stops: the device was removed from WhatsApp > Linked devices.
          logger.error("❌ Device logged out (removed from WhatsApp). Pair again to use the bot.");
          if (watchdog) clearInterval(watchdog);
          process.exit(42); // 42 = "logged out": the supervisor will NOT restart it
          break;

        case DisconnectReason.connectionReplaced: {
          // Another instance is using the same login (for example the old deployment during a redeploy).
          const now = Date.now();
          replacedHits = replacedHits.filter((t) => now - t < 5 * 60 * 1000);
          replacedHits.push(now);
          const wait = replacedHits.length >= 3 ? 5 * 60 * 1000 : 25 * 1000;
          scheduleReconnect(startBot, "connection replaced by another session", wait);
          break;
        }

        case DisconnectReason.badSession:
          scheduleReconnect(startBot, "bad session data", 5000);
          break;

        case DisconnectReason.restartRequired:
          retries = 0;
          scheduleReconnect(startBot, "restart required by WhatsApp", 500);
          break;

        default:
          scheduleReconnect(startBot, `connection closed (${statusCode || "unknown"})`);
      }
    }
  });
}

module.exports = { registerConnectionHandler };
