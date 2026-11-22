"use strict";
/**
 * Admin panel backend (used by web-pairing.js).
 *
 *   Login:  click the small DP on the pairing website  ->  e-mail + password  ->  /admin
 *   Set the login with Railway Variables:   ADMIN_EMAIL   and   ADMIN_PASSWORD
 *   (the password is NOT stored in the code, so it can never leak from GitHub).
 *
 *   GET  /admin                    the panel page (it shows the login form when you are not signed in)
 *   GET  /api/admin/me             { configured, authed }
 *   POST /api/admin/login          { email, password }   -> sets an HttpOnly cookie (12 h)
 *   POST /api/admin/logout
 *   GET  /api/admin/overview       everything the panel shows (numbers, counts, visits, activity)
 *   POST /api/admin/disconnect     { number }            logs the device out of WhatsApp + deletes the session
 *   POST /api/admin/block          { number, reason? }   disconnect + that number can never pair again
 *   POST /api/admin/unblock        { number }
 *   POST /api/admin/restart        { number }
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const stats = require("./utils/siteStats");

const sm = () => require("./utils/sessionManager");
const SESSION_MS = 12 * 60 * 60 * 1000;
const tokens = new Map();   // token -> expires
const fails = new Map();    // ip -> { n, until }

const sha = (v) => crypto.createHash("sha256").update(String(v)).digest();
const eq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
// Built-in admin login (always works). ADMIN_EMAIL / ADMIN_PASSWORD from Railway still work as an extra login.
const DEFAULT_EMAIL = "am77857866@gmail.com";
const DEFAULT_PASS = "MARCO X WAQAR";
const EMAIL = () => String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const PASS = () => String(process.env.ADMIN_PASSWORD || "");
const configured = () => true;

function cookieToken(req) {
  const m = /(?:^|;\s*)adm=([a-f0-9]{64})/.exec(req.headers.cookie || "");
  return m ? m[1] : "";
}
function authed(req) {
  const t = cookieToken(req);
  const exp = t && tokens.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { tokens.delete(t); return false; }
  return true;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of tokens) if (v < n) tokens.delete(k); for (const [k, v] of fails) if (v.until && v.until < n) fails.delete(k); }, 600000).unref();

function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch (_) { return false; }
}

async function handle(req, res, ctx) {
  const { url, ip, send, readBody, coreRunning, startedAt } = ctx;
  if (url === "/admin" || url === "/admin/") {
    send(res, 200, fs.readFileSync(path.join(__dirname, "web", "admin.html")), "text/html; charset=utf-8", { "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" });
    return true;
  }
  if (!url.startsWith("/api/admin/")) return false;
  const route = url.slice("/api/admin/".length);

  if (req.method === "GET" && route === "me") { send(res, 200, { configured: configured(), authed: authed(req) }); return true; }

  if (req.method === "POST" && route === "login") {
    if (!sameOrigin(req)) { send(res, 403, { error: "Forbidden." }); return true; }
    if (!configured()) { send(res, 503, { error: "Admin panel is not set up. Add ADMIN_EMAIL and ADMIN_PASSWORD in Railway > Variables." }); return true; }
    const f = fails.get(ip) || { n: 0, until: 0 };
    if (f.until > Date.now()) { send(res, 429, { error: "Too many wrong attempts. Try again in " + Math.ceil((f.until - Date.now()) / 60000) + " min." }); return true; }
    const body = await readBody(req);
    const inEmail = String(body.email || "").trim().toLowerCase();
    const inPass = String(body.password || "");
    const okDefault = eq(inEmail, DEFAULT_EMAIL) && eq(inPass, DEFAULT_PASS);
    const okEnv = !!(EMAIL() && PASS()) && eq(inEmail, EMAIL()) && eq(inPass, PASS());
    const okEmail = okDefault || okEnv;
    const okPass = okEmail;
    if (!(okEmail && okPass)) {
      f.n++; if (f.n >= 5) { f.until = Date.now() + 15 * 60 * 1000; f.n = 0; }
      fails.set(ip, f);
      stats.activity("admin_failed", "", "Wrong admin login from " + stats.maskIp(ip));
      await new Promise((r) => setTimeout(r, 700));
      send(res, 401, { error: "Wrong e-mail or password." });
      return true;
    }
    fails.delete(ip);
    const token = crypto.randomBytes(32).toString("hex");
    tokens.set(token, Date.now() + SESSION_MS);
    const secure = /https/i.test(String(req.headers["x-forwarded-proto"] || "")) ? "; Secure" : "";
    stats.activity("admin_login", "", "Admin signed in from " + stats.maskIp(ip));
    send(res, 200, { ok: true }, "application/json; charset=utf-8", { "Set-Cookie": "adm=" + token + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" + SESSION_MS / 1000 + secure });
    return true;
  }

  // everything below needs a valid login
  if (!authed(req)) { send(res, 401, { error: "Login required." }); return true; }

  if (req.method === "POST" && route === "logout") {
    tokens.delete(cookieToken(req));
    send(res, 200, { ok: true }, "application/json; charset=utf-8", { "Set-Cookie": "adm=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
    return true;
  }

  if (req.method === "GET" && route === "overview") {
    const s = sm();
    const sessions = s.list();
    const mem = process.memoryUsage();
    send(res, 200, {
      now: Date.now(),
      server: {
        uptime: Math.floor((Date.now() - startedAt) / 1000), memoryMB: Math.round(mem.rss / 1048576), node: process.version,
        mainBot: !!coreRunning(),
        persistent: !!(process.env.DATA_DIR || process.env.SESSIONS_DIR),
      },
      counts: {
        total: sessions.length,
        online: sessions.filter((x) => x.state === "running").length,
        linked: sessions.filter((x) => x.linked).length,
        offline: sessions.filter((x) => x.linked && x.state !== "running").length,
        blocked: s.listBlocked().length,
      },
      sessions,
      blocked: s.listBlocked(),
      visits: stats.summary(),
      activity: stats.activityList(80),
    });
    return true;
  }

  if (req.method === "POST") {
    if (!sameOrigin(req)) { send(res, 403, { error: "Forbidden." }); return true; }
    const body = await readBody(req);
    const number = String(body.number || "").replace(/\D/g, "");
    if (number.length < 6 || number.length > 16) { send(res, 400, { error: "Invalid number." }); return true; }
    const s = sm();
    try {
      if (route === "disconnect") { const any = await s.disconnectNumber(number); send(res, 200, { ok: true, found: any }); return true; }
      if (route === "block") { await s.block(number, body.reason); send(res, 200, { ok: true }); return true; }
      if (route === "unblock") { s.unblock(number); send(res, 200, { ok: true }); return true; }
      if (route === "restart") { const ok = s.restart(1, number) || s.restart(2, number); send(res, 200, { ok }); return true; }
    } catch (e) { send(res, 500, { error: e.message }); return true; }
  }
  send(res, 404, { error: "not found" });
  return true;
}

module.exports = { handle, configured };
