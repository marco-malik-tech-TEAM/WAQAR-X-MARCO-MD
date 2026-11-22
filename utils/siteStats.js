"use strict";
/**
 * Small persistent store for the admin panel:
 *   - website visits (page views, unique visitors per day, recent visits)
 *   - activity log (pair requests, connects, disconnects, blocks, admin logins)
 * Saved in SESSIONS_DIR/_admin.json  (so it survives redeploys when DATA_DIR / a Volume is used).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PROJECT = path.join(__dirname, "..");
const DIR = process.env.SESSIONS_DIR ? path.resolve(process.env.SESSIONS_DIR)
  : process.env.DATA_DIR ? path.join(path.resolve(process.env.DATA_DIR), "sessions") : path.join(PROJECT, "sessions");
const FILE = path.join(DIR, "_admin.json");
const TZ = process.env.TIMEZONE || "Asia/Karachi";

let db = { total: 0, byDay: {}, uniq: { day: "", ids: [] }, recent: [], activity: [] };
try { const j = JSON.parse(fs.readFileSync(FILE, "utf8")); db = { ...db, ...j }; } catch (_) {}
let uniqSet = new Set(db.uniq.ids || []);

let timer = null;
function persist() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      db.uniq = { day: db.uniq.day, ids: [...uniqSet].slice(-5000) };
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(db));
    } catch (_) {}
  }, 3000);
  timer.unref && timer.unref();
}

const dayKey = (t = Date.now()) => { try { return new Date(t).toLocaleDateString("en-CA", { timeZone: TZ }); } catch (_) { return new Date(t).toISOString().slice(0, 10); } };
const maskIp = (ip) => {
  ip = String(ip || "").replace(/^::ffff:/, "");
  if (ip.includes(".")) { const p = ip.split("."); return p.length === 4 ? p[0] + "." + p[1] + ".*.*" : ip; }
  const p = ip.split(":"); return p.slice(0, 3).join(":") + ":*";
};

function visit(ip, ua, pathName) {
  const d = dayKey();
  if (db.uniq.day !== d) { db.uniq.day = d; uniqSet = new Set(); }
  const id = crypto.createHash("sha1").update(String(ip) + "|" + String(ua || "")).digest("hex").slice(0, 12);
  const row = db.byDay[d] || (db.byDay[d] = { views: 0, uniq: 0 });
  row.views++;
  if (!uniqSet.has(id)) { uniqSet.add(id); row.uniq++; }
  db.total++;
  db.recent.unshift({ t: Date.now(), ip: maskIp(ip), path: pathName || "/", ua: String(ua || "").slice(0, 90) });
  if (db.recent.length > 60) db.recent.length = 60;
  const keys = Object.keys(db.byDay).sort();
  while (keys.length > 60) delete db.byDay[keys.shift()];
  persist();
}

function activity(type, number, note) {
  db.activity.unshift({ t: Date.now(), type, number: number ? String(number) : "", note: note ? String(note).slice(0, 160) : "" });
  if (db.activity.length > 300) db.activity.length = 300;
  persist();
}

function summary() {
  const d = dayKey();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const k = dayKey(Date.now() - i * 86400000);
    const r = db.byDay[k] || { views: 0, uniq: 0 };
    days.push({ day: k, views: r.views, uniq: r.uniq });
  }
  const today = db.byDay[d] || { views: 0, uniq: 0 };
  const allUniq = Object.values(db.byDay).reduce((a, r) => a + (r.uniq || 0), 0);
  return {
    total: db.total, today: today.views, todayUnique: today.uniq, uniqueAllTime: allUniq,
    last7: days, recent: db.recent.slice(0, 40),
  };
}
const activityList = (n = 80) => db.activity.slice(0, n);

module.exports = { visit, activity, summary, activityList, maskIp, DIR };
