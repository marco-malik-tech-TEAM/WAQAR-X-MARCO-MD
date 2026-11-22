"use strict";
/**
 * 24/7 supervisor for the MAIN bot (bot-core.js).
 *
 * The bot runs in its own child process. If it crashes, runs out of memory, or you send .restart,
 * it is started again automatically (the website and the Telegram pairing bot keep running).
 * The only time it stays stopped is when you REMOVE the device from WhatsApp > Linked devices
 * (exit code 42), because then there is nothing to reconnect to.
 *
 * Memory guard: if the bot grows too big (a slow memory leak is the usual reason a bot "goes
 * offline after a few hours"), it is restarted cleanly BEFORE the host kills the whole container.
 *   BOT_MAX_MB      override the limit (MB)
 */
const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");

const ROOT = path.join(__dirname, "..");
let child = null;
let startedAt = 0;
let restarts = 0;
let loggedOut = false;
let guard = null;

function containerLimitMB() {
  for (const f of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const v = fs.readFileSync(f, "utf8").trim();
      const n = Number(v);
      if (v !== "max" && Number.isFinite(n) && n > 0 && n < 1e13) return Math.round(n / 1048576);
    } catch (_) {}
  }
  return 0;
}
const LIMIT_MB = (() => {
  if (Number(process.env.BOT_MAX_MB) > 0) return Number(process.env.BOT_MAX_MB);
  const c = containerLimitMB();
  return c ? Math.max(256, Math.round(c * 0.7)) : 1400;
})();

function rssMB(pid) {
  try {
    const m = fs.readFileSync("/proc/" + pid + "/status", "utf8").match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? Math.round(Number(m[1]) / 1024) : 0;
  } catch (_) { return 0; }
}

function spawn() {
  if (child || loggedOut) return;
  const env = { ...process.env };
  for (const k of ["PAIR_NUMBER", "PAIR_REQUEST_ID", "SESSION_DIR"]) delete env[k];
  const heap = Math.max(192, Math.min(1024, Math.round(LIMIT_MB * 0.75)));
  startedAt = Date.now();
  console.log(`🚀 Starting the main bot (process supervised, memory limit ${LIMIT_MB} MB)...`);
  child = fork(path.join(ROOT, "bot-core.js"), [], { cwd: ROOT, env, execArgv: ["--max-old-space-size=" + heap] });
  const me = child;
  child.on("error", (e) => console.error("[supervisor] child error:", e.message));
  child.on("exit", (code, signal) => {
    if (child === me) child = null;
    if (code === 42) {
      loggedOut = true;
      console.error("[supervisor] The device was removed from WhatsApp. Pair again from the website or Telegram.");
      return;
    }
    if (Date.now() - startedAt > 5 * 60 * 1000) restarts = 0; // it was healthy for a while
    const delay = Math.min(60000, 3000 * Math.pow(2, Math.min(restarts++, 4)));
    console.warn(`[supervisor] bot stopped (code ${code}, signal ${signal || "-"}) - restarting in ${Math.round(delay / 1000)}s`);
    setTimeout(spawn, delay);
  });
}

function start() {
  if (loggedOut) { loggedOut = false; restarts = 0; } // a new pairing happened
  spawn();
  if (!guard) {
    guard = setInterval(() => {
      if (!child || !child.pid) return;
      const mb = rssMB(child.pid);
      if (mb && mb > LIMIT_MB) {
        console.warn(`[supervisor] bot uses ${mb} MB (limit ${LIMIT_MB} MB) - restarting it cleanly`);
        try { child.kill("SIGTERM"); } catch (_) {}
        setTimeout(() => { try { child && child.kill("SIGKILL"); } catch (_) {} }, 8000).unref();
      }
    }, 60 * 1000);
    guard.unref();
  }
}

const running = () => !!child;
function stop() { try { child && child.kill("SIGTERM"); } catch (_) {} }
process.on("SIGTERM", () => { stop(); setTimeout(() => process.exit(0), 1500).unref(); });
process.on("exit", stop);

module.exports = { start, running, stop };
