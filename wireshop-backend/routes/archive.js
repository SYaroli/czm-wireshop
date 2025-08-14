// wireshop-backend/routes/archive.js
const express = require("express");
const {
  saveArchivedJob,
  listArchivedJobs,
  getArchivedJob,
  deleteArchivedJob,
  bulkImport,
} = require("../archiveStore");

const router = express.Router();

// List archives
router.get("/", async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 500);
    const offset = Number(req.query.offset ?? 0);
    const rows = await listArchivedJobs({ limit, offset });
    res.json(rows);
  } catch (e) {
    console.error("[ARCHIVE][LIST]", e);
    res.status(500).json({ error: "Failed to list archived jobs" });
  }
});

// Bulk import (must be before :id route)
router.post("/bulk", async (req, res) => {
  try {
    const count = await bulkImport(req.body?.jobs || []);
    res.status(201).json({ imported: count });
  } catch (e) {
    console.error("[ARCHIVE][BULK]", e);
    res.status(500).json({ error: "Bulk import failed" });
  }
});

// Create one archive entry
router.post("/", async (req, res) => {
  try {
    const job = req.body || {};
    if (!job.part_number) {
      return res.status(400).json({ error: "part_number is required" });
    }
    const saved = await saveArchivedJob(job);
    res.status(201).json(saved);
  } catch (e) {
    console.error("[ARCHIVE][CREATE]", e);
    res.status(500).json({ error: "Failed to save archive" });
  }
});

// Get one
router.get("/:id", async (req, res) => {
  try {
    const row = await getArchivedJob(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  } catch (e) {
    console.error("[ARCHIVE][GET]", e);
    res.status(500).json({ error: "Failed to get archive" });
  }
});

// Delete one
router.delete("/:id", async (req, res) => {
  try {
    await deleteArchivedJob(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error("[ARCHIVE][DELETE]", e);
    res.status(500).json({ error: "Failed to delete archive" });
  }
});

module.exports = router;
