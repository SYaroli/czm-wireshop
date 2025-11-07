// wireshop-backend/server.js
// WireShop backend with auto-archive, schedule, assignments, and DB-backed inventory.

const path = require("path");
const express = require("express");
const cors = require("cors");
const attachBuildTasks = require("./build_tasks");

// Force local-time windows to Savannah unless overridden in env
process.env.TZ = process.env.TZ || "America/New_York";

const usersRouter = require("./routes/users");
const jobsRouter = require("./routes/jobs");
const archiveRouter = require("./routes/archive");
const assignmentsRouter = require("./routes/assignments");
const inventoryRoutes = require("./routes/inventory");
const archive = require("./archiveStore");
const db = require("./db"); // ensures DB/tables are created

const TRACE = String(process.env.JOBS_TRACE || "").trim() === "1";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- TEMP auth shim so the UI can know you're admin ----------
app.use((req, _res, next) => {
  if (!req.user) req.user = { name: "Shane", isAdmin: true };
  next();
});

app.get("/api/auth/me", (req, res) => {
  res.json({ name: req.user?.name || "unknown", isAdmin: !!req.user?.isAdmin });
});

// ----- mount routers -----
app.use('/api/users', usersRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/archive', archiveRouter);
app.use('/api/assignments', assignmentsRouter);
app.use('/api', inventoryRoutes);

// NEW: Build Next endpoints (/api/build-tasks/*)
attachBuildTasks(app);

// ---------- Archive init (Postgres mirror) ----------
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

// ---------- Helpers ----------
function parseJSON(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}
function ms(t) { return t ? new Date(t).getTime() : null; }

function mapRow(r) {
  const j = parseJSON(r.job_json);
  const start = ms(r.started_at);
  const end   = ms(r.finished_at);

  const totalMs =
    (r.total_active_sec != null && Number.isFinite(Number(r.total_active_sec)))
      ? Number(r.total_active_sec) * 1000
      : (start && end ? Math.max(0, end - start) : null);

  return {
    id: r.id,
    finishedAt: end,
    startTime: start,
    endTime: end,
    username: r.technician || null,
    partNumber: r.part_number || null,
    printName: j?.printName || j?.print || null,
    expected: r.expected_minutes != null ? Number(r.expected_minutes) : null,
    note: r.notes || null,
    totalActive: totalMs
  };
}

// ---------- Native archive API using archiveStore ----------
const { listArchivedJobs, deleteArchivedJob, updateArchivedJob } = archive;

app.get("/api/jobs/archive", async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 500);
    const offset = Number(req.query.offset ?? 0);
    const rows = await listArchivedJobs({ limit, offset });
    res.json(rows.map(mapRow));
  } catch (e) {
    console.error("[LEGACY /api/jobs/archive] list failed:", e);
    res.status(500).json({ error: "Failed to list archive" });
  }
});

app.post("/api/jobs/archive/:id/delete", async (req, res) => {
  try {
    await deleteArchivedJob(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error("[LEGACY /api/jobs/archive] delete failed:", e);
    res.status(500).json({ error: "Failed to delete archive row" });
  }
});

app.post("/api/jobs/archive/:id/adjust", async (req, res) => {
  try {
    const id = req.params.id;
    const updated = await updateArchivedJob(id, req.body || {});
    res.json({ ok: true, job: updated ? mapRow(updated) : null });
  } catch (e) {
    console.error("[LEGACY /api/jobs/archive] adjust failed:", e);
    res.status(500).json({ error: "Failed to adjust archive row" });
  }
});

app.get("/api/jobs/archive/:id/adjustments", async (_req, res) => {
  res.json([]);
});

// ---------- In-memory hints for auto-archive payload ----------
const lastStartByUser = new Map();
const lastUserByClient = new Map();

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
  if (rec && Date.now() - rec.ts < 10 * 60 * 1000) return rec.username;
  return null;
}

function looksLikeFinish(src = {}, url = "") {
  const u = (url || "").toLowerCase();
  if (u.includes("/finish") || (u.endsWith("/log") && (src.action || "").toLowerCase() === "finish")) return true;
  const lower = k => String(src[k] ?? "").toLowerCase();
  const hay = [lower("action"), lower("status"), lower("event"), lower("op"), lower("type")].join("|");
  return /finish|finished|complete|completed|done|end|stop/.test(hay);
}
function pick(obj, keys) { for (const k of keys) if (obj && obj[k] != null && obj[k] !== "") return obj[k]; return null; }
const toInt = v => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };
const toISO = v => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

function fetchSqliteArchiveForUser(username, cb) {
  if (!username) return cb(null, null);
  const sql = `SELECT * FROM jobs_archive WHERE username = ? ORDER BY id DESC LIMIT 1`;
  db.get(sql, [username], (err, row) => cb(err, row || null));
}

app.use("/api/jobs", (req, res, next) => {
  res.on("finish", async () => {
    if (!archiveReady) return;
    if (res.statusCode >= 400) return;

    const src = { ...(req.body || {}), ...(req.query || {}) };
    const url = req.originalUrl || req.url;
    if (!looksLikeFinish(src, url)) return;

    let username =
      pick(src, ["technician", "tech", "username", "user", "name"]) || getClientUser(req);
    let part =
      pick(src, ["part_number", "partNumber", "part", "partNo", "print", "print_number", "printNumber"]) ||
      (username && lastStartByUser.get(username)?.part_number) || null;

    fetchSqliteArchiveForUser(username, async (_err, sRow) => {
      const started_at =
        toISO(pick(src, ["started_at", "startedAt", "start_time", "startTime"])) ||
        (username && lastStartByUser.get(username)?.started_at) || null;
      const finished_at =
        toISO(pick(src, ["finished_at", "finishedAt", "finish_time", "finishTime"])) ||
        new Date().toISOString();
      const expected_minutes =
        toInt(pick(src, ["expected_minutes", "expected", "expectedMin", "expectedMinutes"])) ??
        (username && lastStartByUser.get(username)?.expected_minutes) ?? null;

      const payload = {
        part_number: part || sRow?.partNumber || null,
        technician: username || sRow?.username || null,
        location: pick(src, ["location", "station", "workstation"]) || null,
        status: "archived",
        expected_minutes,
        total_active_sec:
          toInt(pick(src, ["total_active_sec", "totalSeconds", "total", "elapsed", "timeActiveSec"])) ??
          (sRow ? Math.max(0, Math.trunc((sRow.totalActive || 0) / 1000))
                : (started_at ? Math.max(0, Math.trunc((new Date(finished_at) - new Date(started_at)) / 1000)) : null)),
        started_at: sRow ? new Date(sRow.startTime).toISOString() : started_at,
        finished_at: sRow ? new Date(sRow.endTime).toISOString()   : finished_at,
        notes: pick(src, ["notes", "comment"]) || sRow?.note || null,
        job_json: sRow ? JSON.stringify({ printName: null }) : undefined
      };

      try {
        await archive.saveArchivedJob(payload);
        if (TRACE) console.log("[ARCHIVE] saved with totals:", payload.total_active_sec, "sec");
      } catch (e) {
        console.error("[ARCHIVE] auto-archive failed:", e.message);
      }
    });
  });

  next();
});

// ---------- Schedule Enforcer ----------
const WINDOWS = [
  { start: "10:00", end: "10:15", flag: 1 },
  { start: "12:00", end: "12:30", flag: 1 },
  { start: "14:30", end: "14:45", flag: 1 },
  { start: "17:00", end: "23:59", flag: 2 }
];

function hmToDateToday(hm) { const [H, M] = hm.split(":").map(n => parseInt(n, 10)); const d = new Date(); d.setHours(H, M, 0, 0); return d.getTime(); }
function nowInWindow(w) { const n = Date.now(); const s = hmToDateToday(w.start), e = hmToDateToday(w.end); return n >= s && n < e; }
function currentPolicy() { for (const w of WINDOWS) if (nowInWindow(w)) return { shouldPause: true, flag: w.flag }; return { shouldPause: false, flag: 0 }; }

async function pauseAllActive(flag) {
  const now = Date.now();
  return new Promise((resolve) => {
    db.all(`SELECT * FROM jobs WHERE endTime IS NULL`, [], (err, rows = []) => {
      if (err || !rows.length) return resolve();
      const toPause = rows.filter(r => !r.pauseStart);
      let pending = toPause.length; if (!pending) return resolve();
      toPause.forEach(r => {
        const sql = `UPDATE jobs SET action='Pause', pauseStart=?, autoPaused=? WHERE id=? AND pauseStart IS NULL`;
        db.run(sql, [now, flag, r.id], () => { if (--pending === 0) resolve(); });
      });
    });
  });
}
async function continueAutoPaused() {
  const now = Date.now();
  return new Promise((resolve) => {
    db.all(`SELECT * FROM jobs WHERE endTime IS NULL AND pauseStart IS NOT NULL AND autoPaused = 1`, [], (err, rows = []) => {
      if (err || !rows.length) return resolve();
      let pending = rows.length;
      rows.forEach(r => {
        const paused = now - (r.pauseStart || now);
        const sql = `UPDATE jobs SET action='Continue', pauseTotal=pauseTotal+?, pauseStart=NULL, autoPaused=0 WHERE id=?`;
        db.run(sql, [paused, r.id], () => { if (--pending === 0) resolve(); });
      });
    });
  });
}

let lastState = null;
async function scheduleTick() {
  const pol = currentPolicy();
  const key = pol.shouldPause ? `P${pol.flag}` : 'RUN';
  if (key === lastState) return;
  lastState = key;

  if (pol.shouldPause) await pauseAllActive(pol.flag);
  else await continueAutoPaused();
}
setInterval(scheduleTick, 15000);
setTimeout(scheduleTick, 2000);

// ---------- Health & Static ----------
const FRONTEND_DIR = path.join(__dirname, "..", "wireshop-frontend");
app.use(express.static(FRONTEND_DIR));
app.get("/archive", (_req, res) => res.sendFile(path.join(FRONTEND_DIR, "archive.html")));
app.get("/assignments", (_req, res) => res.sendFile(path.join(FRONTEND_DIR, "assignments.html")));
app.get("/inv/:part", (_req, res) => res.sendFile(path.join(FRONTEND_DIR, "inventory.html")));
app.get("/", (_req, res) => res.sendFile(path.join(FRONTEND_DIR, "index.html")));

// ---------- Errors ----------
app.use((err, _req, res, _next) => {
  console.error("[ERROR]", err);
  res.status(500).json({ error: "Server error" });
});

// ---------- Boot ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`WireShop backend listening on port ${PORT}`);
});
