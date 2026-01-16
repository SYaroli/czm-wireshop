// wireshop-backend/server.js
// WireShop backend with auto-archive, schedule, assignments, and DB-backed inventory.

const path = require("path");
const express = require("express");
const cors = require("cors");
const attachBuildTasks = require("./build_tasks");

// Force local-time windows to Savannah unless overridden in env
process.env.TZ = process.env.TZ || "America/New_York";

const authRouter = require("./routes/auth");
const usersRouter = require("./routes/users");
const jobsRouter = require("./routes/jobs");
const archiveRouter = require("./routes/archive");
const assignmentsRouter = require("./routes/assignments");
const inventoryRoutes = require("./routes/inventory");
const archive = require("./archiveStore");
const db = require("./db"); // ensures DB/tables are created

const TRACE = String(process.env.JOBS_TRACE || "").trim() === "1";

const app = express();

/* ===========================
   CORS (Render + custom domain)
   =========================== */
const ALLOWED_ORIGINS = new Set([
  "https://www.czm-us-wireshop.com",
  "https://czm-us-wireshop.com",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://localhost:5173",
]);

function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser (curl/postman)
  if (ALLOWED_ORIGINS.has(origin)) return true;

  // tolerate subdomains like https://czm-us-wireshop.com and https://www.czm-us-wireshop.com
  try {
    const host = new URL(origin).hostname;
    return host === "czm-us-wireshop.com" || host.endsWith(".czm-us-wireshop.com");
  } catch {
    return false;
  }
}

// Safety middleware: ALWAYS answer preflight with the right headers (even if a route is missing)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Credentials", "true");
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With, x-user, X-User, x-role, x-pin, x-admin"
    );
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Also keep cors() (belt + suspenders)
const corsConfig = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (isAllowedOrigin(origin)) return callback(null, origin); // echo exact origin
    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "x-user",
    "X-User",
    "x-role",
    "x-pin",
    "x-admin",
  ],
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use(cors(corsConfig));
app.options("*", cors(corsConfig));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ----- mount routers -----
app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/archive", archiveRouter);
app.use("/api/assignments", assignmentsRouter);
app.use("/api", inventoryRoutes);

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
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function ms(t) {
  return t ? new Date(t).getTime() : null;
}

function mapRow(r) {
  const j = parseJSON(r.job_json);
  const start = ms(r.started_at);
  const end = ms(r.finished_at);

  const totalMs =
    r.total_active_sec != null && Number.isFinite(Number(r.total_active_sec))
      ? Number(r.total_active_sec) * 1000
      : start && end
      ? Math.max(0, end - start)
      : null;

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
    totalActive: totalMs,
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
  if (
    u.includes("/finish") ||
    (u.endsWith("/log") && (src.action || "").toLowerCase() === "finish")
  )
    return true;
  const lower = (k) => String(src[k] ?? "").toLowerCase();
  const hay = [lower("action"), lower("status"), lower("event"), lower("op"), lower("type")].join("|");
  return /finish|finished|complete|completed|done|end|stop/.test(hay);
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
      pick(src, [
        "part_number",
        "partNumber",
        "part",
        "partNo",
        "print",
        "print_number",
        "printNumber",
      ]) ||
      (username && lastStartByUser.get(username)?.part_number) ||
      null;

    fetchSqliteArchiveForUser(username, async (_err, sRow) => {
      const started_at =
        toISO(pick(src, ["started_at", "startedAt", "start_time", "startTime"])) ||
        (username && lastStartByUser.get(username)?.started_at) ||
        null;
      const finished_at =
        toISO(pick(src, ["finished_at", "finishedAt", "finish_time", "finishTime"])) ||
        new Date().toISOString();
      const expected_minutes =
        toInt(pick(src, ["expected_minutes", "expected", "expectedMin", "expectedMinutes"])) ??
        (username && lastStartByUser.get(username)?.expected_minutes) ??
        null;

      const payload = {
        part_number: part || sRow?.partNumber || null,
        technician: username || sRow?.username || null,
        location: pick(src, ["location", "station", "workstation"]) || null,
        status: "archived",
        expected_minutes,
        total_active_sec:
          toInt(pick(src, ["total_active_sec", "totalSeconds", "total", "elapsed", "timeActiveSec"])) ??
          null,
        started_at,
        finished_at,
        notes: pick(src, ["notes", "note"]) || null,
        job_json: JSON.stringify(src || {}),
      };

      try {
        await archive.insertArchivedJob(payload);
      } catch (e) {
        if (TRACE) console.error("[ARCHIVE] insert failed:", e.message);
      }
    });
  });

  next();
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`WireShop backend listening on ${PORT}`));
