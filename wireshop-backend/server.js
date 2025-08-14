// wireshop-backend/server.js
const path = require("path");
const express = require("express");
const cors = require("cors");

const usersRouter = require("./routes/users");
const jobsRouter = require("./routes/jobs");
const archiveRouter = require("./routes/archive");

// Initialize durable archive (Postgres)
let archiveReady = false;
(async () => {
  try {
    const archive = require("./archiveStore");
    await archive.init();
    archiveReady = true;
    console.log("[ARCHIVE] Postgres archive initialized");
  } catch (err) {
    // If DB is ever missing, we keep the app up but log loudly.
    console.error("[ARCHIVE] init failed; running without durable archive:", err.message);
  }
})();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// API
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
app.get("/", (_req, res) => res.sendFile(path.join(FRONTEND_DIR, "index.html")));

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
