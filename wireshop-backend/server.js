// wireshop-backend/server.js
// WireShop backend with robust auto-archive.
// Caches "Start" on /api/jobs/log (and /logs), fills missing fields on "Finish".

const path = require("path");
const express = require("express");
const cors = require("cors");

const usersRouter = require("./routes/users");
const jobsRouter = require("./routes/jobs");
const archiveRouter = require("./routes/archive");
const archive = require("./archiveStore");

let archiveReady = false;
(async () => {
  try {
    await archive.init();
    archiveReady = true;
    console.log("[ARCHIVE] Postgres archive initialized");
  } catch (err) {
    console.error("[ARCHIVE] init failed; running without durable archive:", err.message);
  }
})();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------------- In-memory hints to fill Finish payloads ----------------
const lastStartByUser = new Map();   // username -> { part_number, technician, started_at, expected_minutes, ts }
const lastUserByClient = new Map();  // clientId -> { username, ts }

function clientId(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ua = String(req.headers["user-agent"] || "");
  return `${xff || req.ip || "?"}|${ua}`;
}
function rememberClientUser(req, username) {
  if (!username) return;
  lastUserByClient.set(clientId(req), { username, ts: Date.now() });
}
function getClientUser(req) {
  const rec = lastUserByClient.get(clientId(req));
  if (rec && Date.now() - rec.ts < 10 * 60 * 1000) return rec.username; // 10 min
  return null;
}
function pruneOld() {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000; // 12h
  for (const [u, v] of lastStartByUser) if (v.ts < cutoff) lastStartByUser.delete(u);
  for (const [c, v] of lastUserByClient) if (v.ts < cutoff) lastUserByClient.delete(c);
}

// ---------------- TRACE every /api/jobs request (leave on) ----------------
app.use("/api/jobs", (req, res, next) => {
  const started = Date.now();
  const method = req.method;
  const url = req.originalUrl || req.url;
  const q = JSON.stringify(req.query || {});
  let bodyPreview = "";
  try { bodyPreview = JSON.stringify(req.body || {}); } catch {}
  if (bodyPreview.length > 800) bodyPreview = bodyPreview.slice(0, 800) + "...";
  res.on("finish", () => {
    const ms = Date.now() - started;
    console.log(`[TRACE] ${method} ${url} -> ${res.statusCode} (${ms}ms) q=${q} body=${bodyPreview}`);
  });
  next();
});

// When the UI fetches logs for a specific user, remember the username for that client.
app.use("/api/jobs/logs/:username", (req, _res, next) => {
  rememberClientUser(req, req.params.username || req.params.user);
  next();
});

// Cache START on /api/jobs/log  (singular, the one your app actually uses)
app.post("/api/jobs/log", (req, _res, next) => {
  const b = req.body || {};
  const isStart = String(b.action || "").toLowerCase() === "start";
  const username = b.username || b.user || b.tech || b.technician || null;
  if (isStart && username) {
    lastStartByUser.set(username, {
      part_number: b.part_number || b.partNumber || b.part || b.print || null,
      technician: username,
      started_at: b.start_time || b.startTime || new Date().toISOString(),
      expected_minutes: b.expected_minutes || b.expected || null,
      ts: Date.now()
    });
    rememberClientUser(req, username);
  }
  next();
});

// Keep old /logs POST too (harmless; covers both shapes)
app.post("/api/jobs/logs", (req, _res, next) => {
  const b = req.body || {};
  const isStart = String(b.action || "").toLowerCase() === "start";
  const username = b.username || b.user || b.tech || b.technician || null;
  if (isStart && username) {
    lastStartByUser.set(username, {
      part_number: b.part_number || b.partNumber || b.part || b.print || null,
      technician: username,
      started_at: b.start_time || b.startTime || new Date().toISOString(),
      expected_minutes: b.expected_minutes || b.expected || null,
      ts: Date.now()
    });
    rememberClientUser(req, username);
  }
  next();
});

// ---------------- Auto-archive for ANY /api/jobs request -----------------
function looksLikeFinish(src = {}, url = "") {
  const u = (url || "").toLowerCase();
  if (u.includes("finish") || u.includes("/finish") || u.includes("complete") || u.includes("/complete")) return true;
  const lower = (k) => String(src[k] ?? "").toLowerCase();
  const haystack = [
    lower("action"),
    lower("status"),
    lower("event"),
    lower("op"),
    lower("type"),
    lower("mode")
  ].join("|");
  return /finish|finished|complete|completed|done|end|stop/.test(haystack);
}
function pick(obj, keys) {
  for (const k of keys) if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  return null;
}
const toInt = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
const toISO = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

app.use("/api/jobs", (req, res, next) => {
  res.on("finish", async () => {
    if (!archiveReady) return;
    if (res.statusCode >= 400) return;

    pruneOld();

    // Merge body + query since some routes are GET-with-query
    const src = { ...(req.body || {}), ...(req.query || {}) };
    const url = req.originalUrl || req.url;
    if (!looksLikeFinish(src, url)) return;

    let username =
      pick(src, ["technician", "tech", "username", "user", "name"]) ||
      getClientUser(req);

    let part =
      pick(src, ["part_number", "partNumber", "part", "partNo", "partno", "print", "print_number", "printNumber"]) ||
      (username && lastStartByUser.get(username)?.part_number) ||
      null;

    const job = {
      part_number: part,                        // archiveStore will coerce null -> "(unknown)"
      technician: username || null,
      location: pick(src, ["location", "station", "workstation"]),
      status: "archived",
      expected_minutes:
        toInt(pick(src, ["expected_minutes", "expected", "expectedMin", "expectedMinutes"])) ??
        (username && lastStartByUser.get(username)?.expected_minutes) ?? null,
      total_active_sec:
        toInt(pick(src, ["total_active_sec", "totalSeconds", "total", "elapsed", "timeActiveSec"])) ?? null,
      started_at:
        toISO(pick(src, ["started_at", "startedAt", "start_time", "startTime"])) ||
        (username && lastStartByUser.get(username)?.started_at) ||
        null,
      finished_at:
        toISO(pick(src, ["finished_at", "finishedAt", "finish_time", "finishTime"])) || new Date().toISOString(),
      notes: pick(src, ["notes", "comment"])
    };

    try {
      await archive.saveArchivedJob({ ...src, ...job });
      console.log("[ARCHIVE] auto-saved:", job.part_number || "(unknown)", "by", job.technician || "(unknown)");
    } catch (e) {
      console.error("[ARCHIVE] auto-archive failed:", e.message);
    }
  });

  next();
}, jobsRouter);

// ---------------- Other API routes ----------------
app.use("/api/users", usersRouter);
app.use("/api/archive", archiveRouter);

// ---------------- Health ----------------
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, archiveReady, node: process.version, now: new Date().toISOString() });
});

// ---------------- Static frontend ----------------
const FRONTEND_DIR = path.join(__dirname, "..", "wireshop-frontend");
app.use(express.static(FRONTEND_DIR));
app.get("/archive", (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "archive.html"));
});
app.get("/", (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

// ---------------- Errors ----------------
/* eslint-disable no-unused-vars */
app.use((err, _req, res, _next) => {
  console.error("[ERROR]", err);
  res.status(500).json({ error: "Server error" });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`WireShop backend listening on port ${PORT}`);
});
