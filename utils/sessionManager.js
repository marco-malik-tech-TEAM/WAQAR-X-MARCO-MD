"use strict";
/**
 * UNLIMITED pairing.
 * Every WhatsApp number that pairs gets its OWN bot process with its OWN login,
 * settings and data (sessions/<engine>/<number>/). Nobody shares anything.
 *
 *   engine 1 = "Bot 1" (this folder)      engine 2 = "Bot 2" (./bot2)
 *
 * - requestPairing(engine, number, tgUserId)  -> resolves with the 8-letter pairing code
 * - autoStartAll()                            -> relaunches every linked session after a restart
 * - remove(engine, number)                    -> logs a session out and deletes it
 *
 * Limit: MAX_SESSIONS env (default 0 = unlimited). Each session needs roughly
 * 150-250 MB of RAM, so the real ceiling is the RAM of your server.
 */
const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");

let PROJECT = path.join(__dirname, "..");
if (path.basename(PROJECT) === "bot2") PROJECT = path.dirname(PROJECT); // when loaded from inside ./bot2
const ENGINES = { 1: PROJECT, 2: path.join(PROJECT, "bot2") };
const SESSIONS_DIR = process.env.SESSIONS_DIR ? path.resolve(process.env.SESSIONS_DIR) : process.env.DATA_DIR ? path.join(path.resolve(process.env.DATA_DIR), "sessions") : path.join(PROJECT, "sessions");
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || "0", 10) || 0;
const CODE_TIMEOUT_MS = 60000;
const LINK_WAIT_MS = 3 * 60 * 1000;
const OWNERS_FILE = path.join(SESSIONS_DIR, "owners.json");
const BLOCK_FILE = path.join(SESSIONS_DIR, "blocked.json");
const stats = require("./siteStats");

const lastRestarts = new Map(); // key -> restart count (since the server started)
const running = new Map(); // key -> { child, engine, number, restarts, lastStart }
const pending = new Map(); // requestId -> { resolve, reject, timer }
let owners = {};
try { owners = JSON.parse(fs.readFileSync(OWNERS_FILE, "utf8")); } catch (_) {}
let blocked = {}; // number -> { at, reason }
try { blocked = JSON.parse(fs.readFileSync(BLOCK_FILE, "utf8")) || {}; } catch (_) {}
const cleanNum = (n) => String(n || "").replace(/\D/g, "");
const isBlocked = (number) => !!blocked[cleanNum(number)];
function saveBlocked() {
  try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); fs.writeFileSync(BLOCK_FILE, JSON.stringify(blocked)); } catch (_) {}
}

const keyOf = (engine, number) => engine + ":" + number;
const dirOf = (engine, number) => path.join(SESSIONS_DIR, "e" + engine, String(number));
const credsOf = (engine, number) => path.join(dirOf(engine, number), "auth_info_baileys", "creds.json");

function saveOwners() {
  try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); fs.writeFileSync(OWNERS_FILE, JSON.stringify(owners)); } catch (_) {}
}
function isLinked(engine, number) {
  try { return !!JSON.parse(fs.readFileSync(credsOf(engine, number), "utf8")).registered; } catch (_) { return false; }
}
const isRunning = (engine, number) => running.has(keyOf(engine, number));

function spawnSession(engine, number, extraEnv = {}) {
  if (isBlocked(number)) throw new Error("This number is blocked.");
  const key = keyOf(engine, number);
  if (running.has(key)) return running.get(key).child;
  const entry = ENGINES[engine];
  const dir = dirOf(engine, number);
  fs.mkdirSync(path.join(dir, "auth_info_baileys"), { recursive: true });
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });

  const env = { ...process.env, UV_THREADPOOL_SIZE: "16", SESSIONS_DIR, ...extraEnv, SESSION_DIR: dir, OWNER_NUMBER: "923377857866,923293245445", LINKED_NUMBER: String(number) };
  for (const k of ["HOST_API_URL", "BOT_KEY", "SESSION_ID", "BOT_SETTINGS_DATA", "PAIR_NUMBER_MAIN"]) delete env[k];
  const child = fork(path.join(entry, "bot-core.js"), [], { cwd: entry, env, execArgv: ["--max-old-space-size=" + (parseInt(process.env.SESSION_HEAP_MB || "320", 10) || 320)], silent: false });
  const rec = { child, engine, number: String(number), lastStart: Date.now(), linkTimer: null, state: "starting", connectedAt: null, restarts: 0 };
  running.set(key, rec);

  // if the user never finishes linking, free the slot
  if (!isLinked(engine, number)) {
    rec.linkTimer = setTimeout(() => {
      if (!isLinked(engine, number)) { try { child.kill(); } catch (_) {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
    }, LINK_WAIT_MS);
  }

  child.on("message", (msg) => {
    if (msg && msg.type === "state") {
      const was = rec.state;
      rec.state = msg.state;
      rec.connectedAt = msg.state === "running" ? (msg.at || Date.now()) : null;
      if (msg.state === "running" && was !== "running") stats.activity("connected", number, "WhatsApp connected");
      if (msg.state === "logged_out") stats.activity("logged_out", number, "Device removed from WhatsApp");
      return;
    }
    if (!msg || !msg.requestId || !pending.has(msg.requestId)) return;
    const p = pending.get(msg.requestId);
    clearTimeout(p.timer);
    pending.delete(msg.requestId);
    if (msg.type === "pairing_code") p.resolve(msg.code);
    else if (msg.type === "pairing_error") p.reject(new Error(msg.message || "Pairing failed."));
  });
  child.on("exit", (code) => {
    clearTimeout(rec.linkTimer);
    running.delete(key);
    console.log(`[sessions] ${key} exited (code ${code})`);
    for (const [id, p] of pending) if (p.number === String(number) && p.engine === engine) { clearTimeout(p.timer); p.reject(new Error("The session closed before the code was ready. Try again.")); pending.delete(id); }
    // keep linked sessions alive (crash/restart), with a small back-off
    if (isLinked(engine, number) && !rec.removed && !isBlocked(number)) {
      const fast = Date.now() - rec.lastStart < 15000;
      lastRestarts.set(key, (lastRestarts.get(key) || 0) + 1);
      setTimeout(() => { if (isLinked(engine, number) && !running.has(key) && !isBlocked(number)) try { spawnSession(engine, number); } catch (_) {} }, fast ? 15000 : 3000);
    }
  });
  child.on("error", (e) => console.error(`[sessions] ${key} error:`, e.message));
  return child;
}

function count() { return running.size; }

function requestPairing(engine, number, tgUserId) {
  number = String(number).replace(/\D/g, "");
  if (isBlocked(number)) return Promise.reject(new Error("This number is blocked by the admin."));
  if (!ENGINES[engine] || !fs.existsSync(path.join(ENGINES[engine], "bot-core.js"))) return Promise.reject(new Error("Bot " + engine + " files are missing."));
  if (isLinked(engine, number)) {
    if (!isRunning(engine, number)) { try { spawnSession(engine, number); } catch (_) {} }
    return Promise.reject(new Error("This number is already linked to Bot " + engine + " and running ✅"));
  }
  if (isRunning(engine, number)) return Promise.reject(new Error("A pairing for this number is already in progress. Wait a minute and try again."));
  if (MAX_SESSIONS && running.size >= MAX_SESSIONS) return Promise.reject(new Error("The server is full right now (" + MAX_SESSIONS + " sessions). Try later."));

  // start from a clean slate for half-finished attempts
  try { fs.rmSync(dirOf(engine, number), { recursive: true, force: true }); } catch (_) {}
  const requestId = Date.now() + "-" + Math.random().toString(36).slice(2);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      const rec = running.get(keyOf(engine, number));
      if (rec && !isLinked(engine, number)) { rec.removed = true; try { rec.child.kill(); } catch (_) {} }
      reject(new Error("Timed out waiting for the pairing code. Please try again."));
    }, CODE_TIMEOUT_MS);
    pending.set(requestId, { resolve, reject, timer, number, engine });
    try {
      if (tgUserId) { owners[keyOf(engine, number)] = tgUserId; saveOwners(); }
      spawnSession(engine, number, { PAIR_NUMBER: number, PAIR_REQUEST_ID: requestId });
    } catch (e) { clearTimeout(timer); pending.delete(requestId); reject(e); }
  });
}

/** Relaunch all linked sessions after a restart (staggered so the CPU is not hit all at once). */
function autoStartAll() {
  const list = [];
  for (const engine of [1, 2]) {
    const base = path.join(SESSIONS_DIR, "e" + engine);
    let names = [];
    try { names = fs.readdirSync(base); } catch (_) {}
    for (const n of names) if (isLinked(engine, n) && !isBlocked(n)) list.push([engine, n]);
  }
  list.forEach(([engine, n], i) => setTimeout(() => { try { spawnSession(engine, n); } catch (e) { console.error("[sessions] start failed", n, e.message); } }, i * 2500));
  if (list.length) console.log(`[sessions] restoring ${list.length} linked session(s)...`);
}

function remove(engine, number) {
  number = String(number).replace(/\D/g, "");
  const rec = running.get(keyOf(engine, number));
  if (rec) { rec.removed = true; try { rec.child.kill(); } catch (_) {} }
  try { fs.rmSync(dirOf(engine, number), { recursive: true, force: true }); } catch (_) {}
  delete owners[keyOf(engine, number)]; saveOwners();
}

/** Sessions that a Telegram user created. */
function listFor(tgUserId) {
  return Object.entries(owners).filter(([, id]) => id === tgUserId).map(([k]) => { const [e, n] = k.split(":"); return { engine: Number(e), number: n, linked: isLinked(Number(e), n), running: isRunning(Number(e), n) }; });
}
const ownerOf = (engine, number) => owners[keyOf(engine, String(number).replace(/\D/g, ""))];

/** Every session on disk or running now (for the admin panel). */
function list() {
  const out = new Map();
  for (const engine of [1, 2]) {
    let names = [];
    try { names = fs.readdirSync(path.join(SESSIONS_DIR, "e" + engine)); } catch (_) {}
    for (const n of names) {
      if (!/^\d{6,16}$/.test(n)) continue;
      let linkedAt = null;
      try { linkedAt = fs.statSync(credsOf(engine, n)).birthtimeMs || fs.statSync(credsOf(engine, n)).mtimeMs; } catch (_) {}
      out.set(keyOf(engine, n), { engine, number: n, linked: isLinked(engine, n), running: false, state: "stopped", connectedAt: null, startedAt: null, restarts: lastRestarts.get(keyOf(engine, n)) || 0, linkedAt, owner: owners[keyOf(engine, n)] || null });
    }
  }
  for (const [key, rec] of running) {
    const row = out.get(key) || { engine: rec.engine, number: rec.number, linked: false, linkedAt: null, restarts: 0, owner: null };
    Object.assign(row, { running: true, state: rec.state, connectedAt: rec.connectedAt, startedAt: rec.lastStart, restarts: lastRestarts.get(key) || 0 });
    out.set(key, row);
  }
  return [...out.values()].map((r) => ({ ...r, blocked: isBlocked(r.number) })).sort((a, b) => (b.linkedAt || b.startedAt || 0) - (a.linkedAt || a.startedAt || 0));
}
const listBlocked = () => Object.entries(blocked).map(([number, v]) => ({ number, at: v.at, reason: v.reason || "" })).sort((a, b) => b.at - a.at);

/** Admin "Disconnect": logs the device out of WhatsApp, stops the session and deletes its files. */
function disconnect(engine, number) {
  number = cleanNum(number);
  const key = keyOf(engine, number);
  const rec = running.get(key);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      try { fs.rmSync(dirOf(engine, number), { recursive: true, force: true }); } catch (_) {}
      delete owners[key]; saveOwners();
      resolve(true);
    };
    if (!rec) return finish();
    rec.removed = true;
    clearTimeout(rec.linkTimer);
    const t = setTimeout(() => { try { rec.child.kill("SIGKILL"); } catch (_) {} finish(); }, 10000);
    rec.child.once("exit", () => { clearTimeout(t); setTimeout(finish, 300); });
    try { rec.child.send({ type: "admin_logout" }); } catch (_) { try { rec.child.kill(); } catch (__) {} }
  });
}

async function disconnectNumber(number) {
  number = cleanNum(number);
  let any = false;
  for (const engine of [1, 2]) {
    if (isLinked(engine, number) || isRunning(engine, number) || fs.existsSync(dirOf(engine, number))) { await disconnect(engine, number); any = true; }
  }
  stats.activity("disconnected", number, "Disconnected by admin");
  return any;
}
async function block(number, reason) {
  number = cleanNum(number);
  if (number.length < 6) throw new Error("Invalid number.");
  blocked[number] = { at: Date.now(), reason: String(reason || "").slice(0, 120) };
  saveBlocked();
  await disconnectNumber(number);
  stats.activity("blocked", number, reason || "Blocked by admin");
}
function unblock(number) {
  number = cleanNum(number);
  delete blocked[number]; saveBlocked();
  stats.activity("unblocked", number, "Unblocked by admin");
}
/** Restart one session (the exit handler starts it again automatically). */
function restart(engine, number) {
  const rec = running.get(keyOf(engine, cleanNum(number)));
  if (!rec) { if (isLinked(engine, number) && !isBlocked(number)) { spawnSession(engine, cleanNum(number)); return true; } return false; }
  try { rec.child.kill(); } catch (_) {}
  stats.activity("restarted", number, "Restarted by admin");
  return true;
}
/** 24/7 guard: any linked (and not blocked) number whose process is not running is started again. */
function ensureAlive() {
  let n = 0;
  // zombie guard: a session whose bot never reached "running" for 8 minutes (stuck connecting) is restarted
  for (const [key, rec] of running) {
    try {
      if (isLinked(rec.engine, rec.number) && rec.state !== "running" && rec.state !== "logged_out" && Date.now() - rec.lastStart > 8 * 60 * 1000) {
        console.warn("[sessions] " + key + " stuck in state '" + rec.state + "' - restarting it");
        rec.lastStart = Date.now();
        rec.child.kill();
      }
    } catch (_) {}
  }
  for (const engine of [1, 2]) {
    let names = [];
    try { names = fs.readdirSync(path.join(SESSIONS_DIR, "e" + engine)); } catch (_) {}
    for (const num of names) {
      if (isLinked(engine, num) && !isBlocked(num) && !running.has(keyOf(engine, num))) {
        try { spawnSession(engine, num); n++; } catch (_) {}
      }
    }
  }
  if (n) console.log("[sessions] keep-alive restarted " + n + " session(s)");
}

module.exports = { requestPairing, autoStartAll, remove, listFor, ownerOf, count, isLinked, isRunning, list, listBlocked, isBlocked, disconnectNumber, block, unblock, restart, ensureAlive, SESSIONS_DIR };
