// wireshop-backend/server.js
// Express server for CZM WireShop with logging + robust auto-archive.

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

// -------- TRACE every /api/jobs request so we know exactly what the admin sends
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

// -------- Auto-archive for ANY /api/jobs request that looks like finish/complete
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

// Wrap ALL /api/jobs traffic, regardless of method (GET/POST/etc)
app.use("/api/jobs", (req, res, next) => {
  res.on("finish", async () => {
    if (!archiveReady) return;
    if (res.statusCode >= 400) return;

    // Merge body + query since some routes are GET-with-query
    const src = { ...(req.body || {}), ...(req.query || {}) };

    if (!looksLikeFinish(src, req.originalUrl || req.url)) return;

    try {
      const job = {
        part_number: pick(src, [
          "part_number", "partNumber", "part", "partNo", "partno",
          "print", "print_number", "printNumber"
        ]),
        technician: pick(src, ["technician", "tech", "username", "user", "name"]),
        location: pick(src, ["location", "station", "workstation"]),
        status: "archived",
        expected_minutes: toInt(pick(src, ["expected_minutes", "expected", "expectedMin", "expectedMinutes"])),
        total_active_sec: toInt(pick(src, ["total_active_sec", "totalSeconds", "total", "elapsed", "timeActiveSec"])),
        started_at: toISO(pick(src, ["started_at", "startedAt", "start_time", "startTime"])),
        finished_at: toISO(pick(src, ["finished_at", "finishedAt", "finish_time", "finishTime"])) || new Date().toISOString(),
        notes: pick(src, ["notes", "comment"])
      };

      await archive.saveArchivedJob({ ...src, ...job });
      console.log("[ARCHIVE] auto-saved:", job.part_number || "(no part)", "by", job.technician || "(unknown)");
    } catch (e) {
      console.error("[ARCHIVE] auto-archive failed:", e.message);
    }
  });

  next();
}, jobsRouter);

// Other API routes
app.use("/api/users", usersRouter);
app.use("/api/archive", archiveRouter);

// Health
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, archiveReady, node: process.version, now: new Date().toISOString() });
});

// Static frontend
const FRONTEND_DIR = path.join(__dirname, "..", "wireshop-frontend");
app.use(express.static(FRONTEND_DIR));
app.get("/archive", (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "archive.html"));
});
app.get("/", (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

// Errors
/* eslint-disable no-unused-vars */
app.use((err, _req, res, _next) => {
  console.error("[ERROR]", err);
  res.status(500).json({ error: "Server error" });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`WireShop backend listening on port ${PORT}`);
});
