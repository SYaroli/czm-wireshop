// wireshop-backend/server.js
// Express server for CZM WireShop with automatic archiving on job finish.

const path = require("path");
const express = require("express");
const cors = require("cors");

const usersRouter = require("./routes/users");
const jobsRouter = require("./routes/jobs");
const archiveRouter = require("./routes/archive");

// Postgres archive
const archive = require("./archiveStore");

// If your finish endpoint path is different, change this:
const FINISH_PATH = "/api/jobs/finish";

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

/**
 * Auto-archive hook:
 * We register a lightweight handler on the same path your app uses to finish a job.
 * It does NOTHING to the request/response. It just listens for a successful response
 * and then writes an archive row in the background.
 */
app.post(FINISH_PATH, (req, res, next) => {
  // Let the real /api/jobs/finish route run first.
  res.on("finish", async () => {
    // Only archive if the finish call succeeded.
    if (!archiveReady) return;
    if (res.statusCode >= 400) return;

    try {
      const b = req.body || {};
      // Best-effort mapping. We also store the full payload in job_json.
      const job = {
        part_number:
          b.part_number || b.partNumber || b.part || b.partNo || b.partno || null,
        technician:
          b.technician || b.username || b.user || b.name || null,
        location:
          b.location || b.station || b.workstation || null,
        status: "archived",
        expected_minutes:
          b.expected_minutes || b.expected || b.expectedMin || null,
        total_active_sec:
          b.total_active_sec || b.totalSeconds || b.total || b.elapsed || null,
        started_at: b.started_at || b.startedAt || null,
        finished_at: b.finished_at || b.finishedAt || new Date().toISOString(),
        notes: b.notes || null,
        // archiveStore will also persist the entire body into job_json
      };

      // Save it. archiveStore handles JSON packing and null-safety.
      await archive.saveArchivedJob({ ...job, ...{ job_json: undefined } });
      console.log(
        "[ARCHIVE] Auto-saved on finish:",
        job.part_number || "(no part)"
      );
    } catch (e) {
      console.error("[ARCHIVE] auto-archive failed:", e.message);
    }
  });

  // Hand off to the real route in routes/jobs.js
  next();
});

// API routes
app.use("/api/users", usersRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/archive", archiveRouter);

// Health
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, archiveReady, node: process.version, now: new Date().toISOString() });
});

// Static frontend
const FRONTEND_DIR = path.join(__dirname, "..", "wireshop-frontend");
app.use(express.static(FRONTEND_DIR));

// Shortcut to the archive viewer
app.get("/archive", (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "archive.html"));
});

// Default: login page
app.get("/", (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

// Errors
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("[ERROR]", err);
  res.status(500).json({ error: "Server error" });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`WireShop backend listening on port ${PORT}`);
});
