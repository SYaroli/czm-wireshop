// wireshop-backend/archiveStore.js
// Durable archive storage using Postgres with helpful indexes and sane time math.

let Pool;
try {
  ({ Pool } = require("pg"));
} catch {
  console.error("[ARCHIVE] 'pg' is not installed.");
}

const conn = process.env.DATABASE_URL || "";
const pool = conn && Pool ? new Pool({
  connectionString: conn,
  ssl: { rejectUnauthorized: false }
}) : null;

async function init() {
  if (!pool) return;
  // Create table if missing (idempotent)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS archive_jobs (
      id SERIAL PRIMARY KEY,
      technician TEXT,
      part_number TEXT,
      location TEXT,
      expected_minutes INTEGER,
      notes TEXT,
      total_active_sec INTEGER,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      job_json JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_archive_finished ON archive_jobs(finished_at DESC);
    CREATE INDEX IF NOT EXISTS idx_archive_tech ON archive_jobs(technician);
    CREATE INDEX IF NOT EXISTS idx_archive_part ON archive_jobs(part_number);
  `);
}

function safeJson(j) {
  try { return j ? JSON.stringify(j) : null; } catch { return null; }
}

// ---------- Save a new archived job ----------
async function saveArchivedJob(job = {}) {
  await init();
  if (!pool) return null;

  // Inputs may be strings or Dates. Normalize.
  const startedIso  = job.started_at ? new Date(job.started_at).toISOString() : null;
  const finishedIso = job.finished_at ? new Date(job.finished_at).toISOString() : null;

  // total_active_sec may be provided; if not, compute from started/finished and optional pause
  let totalSec = Number.isFinite(Number(job.total_active_sec)) ? Math.trunc(Number(job.total_active_sec)) : null;
  if (totalSec == null && startedIso && finishedIso) {
    const startMs = new Date(startedIso).getTime();
    const endMs   = new Date(finishedIso).getTime();
    const pauseMs = Number.isFinite(Number(job.pause_total_ms)) ? Number(job.pause_total_ms) : 0;
    const activeMs = Math.max(0, endMs - startMs - Math.max(0, pauseMs));
    totalSec = Math.trunc(activeMs / 1000);
  }

  const res = await pool.query(
    `INSERT INTO archive_jobs
       (technician, part_number, location, expected_minutes, notes, total_active_sec, started_at, finished_at, job_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      job.technician || null,
      job.part_number || null,
      job.location || null,
      Number.isFinite(Number(job.expected_minutes)) ? Math.trunc(Number(job.expected_minutes)) : null,
      job.notes || null,
      totalSec,
      startedIso,
      finishedIso,
      safeJson(job.job_json)
    ]
  );
  return res.rows[0] || null;
}

// ---------- List archived jobs with basic filters ----------
async function listArchivedJobs({ limit = 500, offset = 0 } = {}) {
  await init();
  if (!pool) return [];
  const res = await pool.query(
    `SELECT * FROM archive_jobs ORDER BY finished_at DESC NULLS LAST LIMIT $1 OFFSET $2`,
    [Math.max(0, limit|0), Math.max(0, offset|0)]
  );
  return res.rows;
}

// ---------- Get one ----------
async function getArchivedJob(id) {
  await init();
  if (!pool) return null;
  const res = await pool.query(`SELECT * FROM archive_jobs WHERE id = $1`, [Number(id)]);
  return res.rows[0] || null;
}

// ---------- Update (Adjust) ----------
/*
  Payload from admin UIs:
    username -> technician (TEXT)
    partNumber -> part_number (TEXT)
    note -> notes (TEXT)
    startTime -> ms
    endTime   -> ms
    pauseTotal -> ms
    expected (minutes) may not be sent here, but handle if present.
*/
async function updateArchivedJob(id, payload = {}) {
  await init();
  if (!pool) return null;

  // Fetch current row
  const curRes = await pool.query(`SELECT * FROM archive_jobs WHERE id = $1`, [Number(id)]);
  const cur = curRes.rows[0];
  if (!cur) return null;

  // Normalize incoming overrides
  const username   = payload.username ?? null;
  const partNumber = payload.partNumber ?? null;
  const note       = payload.note ?? null;

  const startMs = Number.isFinite(Number(payload.startTime)) ? Number(payload.startTime) : null;
  const endMs   = Number.isFinite(Number(payload.endTime))   ? Number(payload.endTime)   : null;
  const pauseMs = Number.isFinite(Number(payload.pauseTotal))? Number(payload.pauseTotal): null;

  // Compose new values
  const startedIso  = startMs != null ? new Date(startMs).toISOString() : null;
  const finishedIso = endMs   != null ? new Date(endMs).toISOString()   : null;

  // Use latest values for recompute
  const finalStartMs = startMs != null ? startMs : (cur.started_at ? new Date(cur.started_at).getTime() : null);
  const finalEndMs   = endMs   != null ? endMs   : (cur.finished_at ? new Date(cur.finished_at).getTime() : null);

  // We don't store pause_total separately in Postgres; we fold it into total_active_sec.
  // If pauseMs provided, recompute; otherwise keep existing total when possible, or recompute from start/end.
  let totalSec = cur.total_active_sec;
  if ((finalStartMs != null && finalEndMs != null) && (pauseMs != null || startMs != null || endMs != null)) {
    const p = pauseMs != null ? Math.max(0, pauseMs) : 0;
    const activeMs = Math.max(0, finalEndMs - finalStartMs - p);
    totalSec = Math.trunc(activeMs / 1000);
  }

  // Build dynamic update
  const sets = [];
  const vals = [];
  let i = 1;
  function set(col, value) { sets.push(`${col} = $${i++}`); vals.push(value); }

  if (username !== null)   set('technician', username || null);
  if (partNumber !== null) set('part_number', partNumber || null);
  if (note !== null)       set('notes', note || null);
  if (startedIso)          set('started_at', startedIso);
  if (finishedIso)         set('finished_at', finishedIso);
  if (totalSec != null)    set('total_active_sec', Math.trunc(totalSec));

  if (sets.length === 0) return cur; // nothing to update

  const sql = `UPDATE archive_jobs SET ${sets.join(', ')} WHERE id = $${i} RETURNING *;`;
  vals.push(Number(id));
  const res = await pool.query(sql, vals);
  return res.rows[0] || null;
}

// ---------- Delete ----------
async function deleteArchivedJob(id) {
  await init();
  if (!pool) return false;
  await pool.query(`DELETE FROM archive_jobs WHERE id = $1;`, [Number(id)]);
  return true;
}

// ---------- Bulk import (JSON export -> Postgres) ----------
async function bulkImport(jobs = []) {
  await init();
  if (!pool || !Array.isArray(jobs) || jobs.length === 0) return 0;

  const text = `
    INSERT INTO archive_jobs
      (technician, part_number, location, expected_minutes, notes, total_active_sec, started_at, finished_at, job_json)
    VALUES
      %VALUES%
    RETURNING id
  `;
  const rows = [];
  const vals = [];
  let i = 1;
  for (const j of jobs) {
    const startedIso  = j.started_at ? new Date(j.started_at).toISOString() : null;
    const finishedIso = j.finished_at ? new Date(j.finished_at).toISOString() : null;
    const totalSec = Number.isFinite(Number(j.total_active_sec)) ? Math.trunc(Number(j.total_active_sec)) : null;

    rows.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
    vals.push(
      j.technician || null,
      j.part_number || null,
      j.location || null,
      Number.isFinite(Number(j.expected_minutes)) ? Math.trunc(Number(j.expected_minutes)) : null,
      j.notes || null,
      totalSec,
      startedIso,
      finishedIso,
      safeJson(j.job_json)
    );
  }
  const sql = text.replace('%VALUES%', rows.join(','));
  const res = await pool.query(sql, vals);
  return res.rowCount || 0;
}

module.exports = {
  init,
  saveArchivedJob,
  listArchivedJobs,
  getArchivedJob,
  updateArchivedJob,
  deleteArchivedJob,
  bulkImport,
};
