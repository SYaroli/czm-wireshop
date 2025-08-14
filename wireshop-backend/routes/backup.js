// routes/backup.js — export/import JSON backups of all tables
// Admin-only using ADMIN_USERS env and 'x-user' header (same pattern as jobs/users)

const express = require('express');
const router = express.Router();
const db = require('../db');

const ADMIN_USERS = (process.env.ADMIN_USERS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const currentUser = req => (req.header('x-user') || '').toLowerCase();
const requireAdmin = (req, res, next) =>
  ADMIN_USERS.includes(currentUser(req)) ? next() : res.status(403).json({ error: 'Admin only' });

// Small helpers to promisify db ops
const all = (sql, params = []) => new Promise((resolve, reject) =>
  db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || [])));
const run = (sql, params = []) => new Promise((resolve, reject) =>
  db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));

async function tableColumns(name) {
  const info = await all(`PRAGMA table_info(${name})`);
  return info.map(c => c.name);
}

// GET /api/backup/export  -> JSON snapshot of all tables
router.get('/export', requireAdmin, async (_req, res) => {
  try {
    const [jobs, archive, adjustments, users] = await Promise.all([
      all(`SELECT * FROM jobs`),
      all(`SELECT * FROM jobs_archive`),
      all(`SELECT * FROM jobs_adjustments`),
      all(`SELECT * FROM users`),
    ]);
    res.json({ jobs, archive, adjustments, users, exportedAt: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/backup/import  -> replace tables from posted JSON (admin-only)
// Body shape: { jobs:[], archive:[], adjustments:[], users:[] }
router.post('/import', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const data = {
    jobs: Array.isArray(body.jobs) ? body.jobs : [],
    archive: Array.isArray(body.archive) ? body.archive : [],
    adjustments: Array.isArray(body.adjustments) ? body.adjustments : [],
    users: Array.isArray(body.users) ? body.users : [],
  };

  try {
    // Find column lists dynamically so we don’t get out of sync with schema
    const cols = {
      jobs: await tableColumns('jobs'),
      jobs_archive: await tableColumns('jobs_archive'),
      jobs_adjustments: await tableColumns('jobs_adjustments'),
      users: await tableColumns('users'),
    };

    await run('BEGIN');

    // Clear tables
    await Promise.all([
      run('DELETE FROM jobs'),
      run('DELETE FROM jobs_archive'),
      run('DELETE FROM jobs_adjustments'),
      run('DELETE FROM users'),
    ]);

    // Generic insert function
    async function insertMany(table, rows, allowedCols) {
      if (!rows.length) return;
      const colSet = new Set(allowedCols);
      for (const r of rows) {
        const keys = Object.keys(r).filter(k => colSet.has(k));
        if (!keys.length) continue;
        const placeholders = keys.map(() => '?').join(',');
        const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${placeholders})`;
        const vals = keys.map(k => r[k]);
        await run(sql, vals);
      }
    }

    await insertMany('jobs',               data.jobs,        cols.jobs);
    await insertMany('jobs_archive',       data.archive,     cols.jobs_archive);
    await insertMany('jobs_adjustments',   data.adjustments, cols.jobs_adjustments);
    await insertMany('users',              data.users,       cols.users);

    await run('COMMIT');
    res.json({ success: true, counts: {
      jobs: data.jobs.length,
      archive: data.archive.length,
      adjustments: data.adjustments.length,
      users: data.users.length,
    }});
  } catch (err) {
    await run('ROLLBACK').catch(()=>{});
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
