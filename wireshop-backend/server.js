// wireshop-backend/server.js
// Express server for CZM WireShop.
// Boots archive persistence (Postgres) so redeploys stop wiping history.

const path = require("path");
const express = require("express");
const cors = require("cors");

// Routers
const usersRouter = require("./routes/users");
const jobsRouter = require("./routes/jobs");

// Durable archive (Postgres)
let archiveReady = false;
(async () => {
  try {
    const archive = require("./archiveStore"); // created earlier
    await archive.init();
    archiveReady = true;
    console.log("[ARCHIVE] Postgres archive initialized");
  } catch (err) {
    console.error("[ARCHIVE] init failed:", err.message);
    // Fail fast. If we run without durable storage, you lose data on redeploy.
    process.exit(1);
  }
})();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// API routes (unchanged)
app.use("/api/users", usersRouter);
app.use("/api/jobs", jobsRouter);

// Health/diagnostics
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    archiveReady,
    node: process.version,
    now: new Date().toISOString(),
  });
});

// Static frontend
const FRONTEND_DIR = path.join(__dirname, "..", "wireshop-frontend");
app.use(express.static(FRONTEND_DIR));

// Default: serve the login page
app.get("/", (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("[ERROR]", err);
  res.status(500).json({ error: "Server error" });
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`WireShop backend listening on port ${PORT}`);
});
