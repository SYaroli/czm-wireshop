// wireshop-backend/archiveStore.js
// Durable archive storage using Postgres.

let Pool;
try {
  ({ Pool } = require("pg"));
} catch {
  console.error("[ARCHIVE] 'pg' is not installed. We’ll need it when we wire this up.");
}

const conn = process.env.DATABASE_URL || "";
const pool = conn && Pool ? new Pool({
  connectionString: conn,
  ssl: { rejectUnauthorized: false }
}) : null;

async function init() {
  if (!pool) throw new Error("[ARCHIVE] DATABASE_URL missing or 'pg' not installed.");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS archive_jobs (
      id                BIGSERIAL PRIMARY KEY,
      part_number       TEXT NOT NULL,
      technician        TEXT,
      location          TEXT,
      status            TEXT,
      expected_minutes  INTEGER,
      total_active_sec  INTEGER,
      started_at        TIMESTAMPTZ,
      finished_at       TIMESTAMPTZ,
      notes             TEXT,
      job_json          JSONB,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function saveArchivedJob(job) {
  await init();
  const {
    part_number = null,
    technician = null,
    location = null,
    status = "archived",
    expected_minutes = null,
    total_active_sec = null,
    started_at = null,
    finished_at = null,
    notes = null,
  } = job || {};

  const pn = part_number || "(unknown)"; // never null
  const res = await pool.query(
    `
    INSERT INTO archive_jobs
      (part_number, technician, location, status, expected_minutes, total_active_sec,
       started_at, finished_at, notes, job_json)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING *;
    `,
    [
      pn,
      technician,
      location,
      status,
      toInt(expected_minutes),
      toInt(total_active_sec),
      toTs(started_at),
      toTs(finished_at),
      notes,
      safeJson(job),
    ]
  );
  return res.rows[0];
}

async function listArchivedJobs({ limit = 500, offset = 0 } = {}) {
  await init();
  const res = await pool.query(
    `SELECT id, part_number, technician, location, status, expected_minutes,
            total_active_sec, started_at, finished_at, notes, job_json, created_at
     FROM archive_jobs
     ORDER BY id DESC
     LIMIT $1 OFFSET $2;`,
    [limit, offset]
  );
  return res.rows;
}

async function getArchivedJob(id) {
  await init();
  const res = await pool.query(`SELECT * FROM archive_jobs WHERE id = $1 LIMIT 1;`, [Number(id)]);
  return res.rows[0] || null;
}

async function deleteArchivedJob(id) {
  await init();
  await pool.query(`DELETE FROM archive_jobs WHERE id = $1;`, [Number(id)]);
  return true;
}

async function bulkImport(jobs = []) {
  await init();
  if (!Array.isArray(jobs) || jobs.length === 0) return 0;
  await pool.query("BEGIN");
  try {
    for (const j of jobs) await saveArchivedJob(j);
    await pool.query("COMMIT");
    return jobs.length;
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  }
}

// helpers
function toInt(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function toTs(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function safeJson(j) {
  try { return j ? JSON.stringify(j) : null; } catch { return null; }
}

module.exports = {
  init,
  saveArchivedJob,
  listArchivedJobs,
  getArchivedJob,
  deleteArchivedJob,
  bulkImport,
};
