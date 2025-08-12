// routes/jobs.js
const express = require('express');
const router = express.Router();
const db = require('../db');

// Admin list via env var: ADMIN_USERS=shane.yaroli,giuliano.clo
const ADMIN_USERS = (process.env.ADMIN_USERS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const currentUser = req => (req.header('x-user') || '').toLowerCase();
const requireAdmin = (req, res, next) =>
  ADMIN_USERS.includes(currentUser(req)) ? next() : res.status(403).json({ error: 'Admin only' });

// ---- helpers ----
function finalizeTotals(row, explicitEndTime) {
  const now = explicitEndTime || Date.now();
  let pauseTotal = row.pauseTotal || 0;
  if (row.pauseStart) pauseTotal += (now - row.pauseStart);
  const totalActive = Math.max(0, (now - (row.startTime || now)) - pauseTotal);
  return { endTime: now, pauseTotal, totalActive };
}

function applyAdj(base, adj) {
  if (!adj) {
    const totalActive = base.totalActive ?? Math.max(0, (base.endTime - base.startTime) - (base.pauseTotal || 0));
    return { ...base, totalActive };
  }
  const username   = adj.overrideUsername   ?? base.username;
  const partNumber = adj.overridePartNumber ?? base.partNumber;
  const note       = adj.overrideNote       ?? base.note;
  const startTime  = adj.overrideStartTime  ?? base.startTime;
  const endTime    = adj.overrideEndTime    ?? base.endTime;
  const pauseTotal = adj.overridePauseTotal ?? base.pauseTotal;
  const totalActive = Math.max(0, (endTime - startTime) - (pauseTotal || 0));
  return {
    ...base,
    username, partNumber, note, startTime, endTime, pauseTotal, totalActive,
    adjusted: 1, lastAdjustmentAt: adj.createdAt, lastAdjustmentBy: adj.adminUser
  };
}

function getLatestAdjustments(cb) {
  const sql = `
    SELECT a.*
    FROM jobs_adjustments a
    JOIN (
      SELECT archiveId, MAX(id) AS maxId
      FROM jobs_adjustments
      GROUP BY archiveId
    ) m ON a.archiveId = m.archiveId AND a.id = m.maxId
  `;
  db.all(sql, [], cb);
}

// ---- live: create ----
router.post('/log', (req, res) => {
  const { username, partNumber, action, note, startTime, endTime } = req.body;
  if (!username || !partNumber || !action) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const stmt = `
    INSERT INTO jobs (username, partNumber, action, note, startTime, endTime, pauseStart, pauseTotal)
    VALUES (?, ?, ?, ?, ?, ?, NULL, 0)
  `;
  db.run(stmt, [username, partNumber, action, note || '', startTime || Date.now(), endTime || null], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    db.get(`SELECT * FROM jobs WHERE id = ?`, [this.lastID], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID, log: row });
    });
  });
});

// ---- live: update/pause/continue/finish -> archive ----
router.put('/log/:id', (req, res) => {
  const id = req.params.id;
  const { action, endTime } = req.body;

  db.get(`SELECT * FROM jobs WHERE id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Log not found' });

    const now = Date.now();
    let stmt = `UPDATE jobs SET action = ?`;
    const params = [action || row.action];

    if (action === 'Pause' && !row.pauseStart) {
      stmt += `, pauseStart = ?`;
      params.push(now);
    } else if (action === 'Continue' && row.pauseStart) {
      const paused = now - row.pauseStart;
      stmt += `, pauseTotal = pauseTotal + ?, pauseStart = NULL`;
      params.push(paused);
    }

    // finishing path
    if (action === 'Finish' || endTime) {
      const totals = finalizeTotals(row, endTime);
      stmt += `, endTime = ?, pauseStart = NULL, pauseTotal = ?`;
      params.push(totals.endTime, totals.pauseTotal);

      db.run(stmt + ` WHERE id = ?`, [...params, id], (err2) => {
        if (err2) return res.status(500).json({ error: 'Failed to update before archive', details: err2.message });

        db.get(`SELECT * FROM jobs WHERE id = ?`, [id], (err3, r) => {
          if (err3) return res.status(500).json({ error: err3.message });
          const fin = finalizeTotals(r, r.endTime || now);

          const ins = `
            INSERT INTO jobs_archive (sourceId, username, partNumber, note, startTime, endTime, pauseTotal, totalActive)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `;
          db.run(ins, [r.id, r.username, r.partNumber, r.note || '', r.startTime || now, fin.endTime, fin.pauseTotal, fin.totalActive], function (err4) {
            if (err4) return res.status(500).json({ error: 'Archive insert failed', details: err4.message });

            db.run(`DELETE FROM jobs WHERE id = ?`, [id], (err5) => {
              if (err5) return res.status(500).json({ error: 'Failed to remove live row after archive' });
              db.get(`SELECT * FROM jobs_archive WHERE id = ?`, [this.lastID], (err6, archived) => {
                if (err6) return res.status(500).json({ error: err6.message });
                res.json({ success: true, archived: true, archive: archived });
              });
            });
          });
        });
      });
      return;
    }

    // pause/continue only
    db.run(stmt + ` WHERE id = ?`, [...params, id], (err2) => {
      if (err2) return res.status(500).json({ error: 'Failed to update log', details: err2.message });
      db.get(`SELECT * FROM jobs WHERE id = ?`, [id], (err3, out) => {
        if (err3) return res.status(500).json({ error: err3.message });
        res.json({ success: true, log: out });
      });
    });
  });
});

// ---- live: read admins ----
router.get('/logs', requireAdmin, (req, res) => {
  db.all(`SELECT * FROM jobs ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ---- live: read user ----
router.get('/logs/:username', (req, res) => {
  const requester = currentUser(req);
  const target = (req.params.username || '').toLowerCase();
  const isAdmin = ADMIN_USERS.includes(requester);
  if (!isAdmin && requester !== target) return res.status(403).json({ error: 'Forbidden' });

  db.all(`SELECT * FROM jobs WHERE username = ? ORDER BY id DESC`, [req.params.username], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ---- archive: read with adjustments applied ----
router.get('/archive', requireAdmin, (req, res) => {
  db.all(`SELECT * FROM jobs_archive ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    getLatestAdjustments((err2, adjs) => {
      if (err2) return res.status(500).json({ error: err2.message });
      const map = new Map(adjs.map(a => [a.archiveId, a]));
      const merged = rows.map(r => applyAdj(r, map.get(r.id)));
      res.json(merged);
    });
  });
});

// ---- archive: add an adjustment (admin) ----
// Accepts any subset of: startTime, endTime, pauseTotal, partNumber, note, username, reason (required)
router.post('/archive/:id/adjust', requireAdmin, (req, res) => {
  const archiveId = parseInt(req.params.id, 10);
  const { startTime, endTime, pauseTotal, partNumber, note, username, reason } = req.body || {};
  if (!reason) return res.status(400).json({ error: 'reason required' });

  db.get('SELECT * FROM jobs_archive WHERE id = ?', [archiveId], (err, base) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!base) return res.status(404).json({ error: 'archive row not found' });

    const u = currentUser(req);
    const stmt = `
      INSERT INTO jobs_adjustments
        (archiveId, overrideStartTime, overrideEndTime, overridePauseTotal, overridePartNumber, overrideNote, overrideUsername, reason, adminUser)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    db.run(stmt, [
      archiveId,
      startTime ?? null,
      endTime ?? null,
      pauseTotal ?? null,
      partNumber ?? null,
      note ?? null,
      username ?? null,
      String(reason),
      u
    ], function (err2) {
      if (err2) return res.status(500).json({ error: err2.message });

      db.get('SELECT * FROM jobs_adjustments WHERE id = ?', [this.lastID], (err3, adj) => {
        if (err3) return res.status(500).json({ error: err3.message });
        const merged = applyAdj(base, adj);
        res.json({ success: true, adjustmentId: this.lastID, archive: merged });
      });
    });
  });
});

// ---- archive: list all adjustments for a row (admin) ----
router.get('/archive/:id/adjustments', requireAdmin, (req, res) => {
  db.all('SELECT * FROM jobs_adjustments WHERE archiveId = ? ORDER BY id ASC', [req.params.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ---- live admin deletes (does not touch archive) ----
router.delete('/log/:id', requireAdmin, (req, res) => {
  db.run(`DELETE FROM jobs WHERE id = ?`, [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to delete log' });
    res.json({ success: true, message: `Log ${req.params.id} deleted` });
  });
});

router.delete('/admin/clear-logs', requireAdmin, (req, res) => {
  db.run(`DELETE FROM jobs`, (err) => {
    if (err) return res.status(500).json({ error: 'Failed to clear logs' });
    res.json({ success: true, message: 'All live logs cleared by admin' });
  });
});

module.exports = router;
