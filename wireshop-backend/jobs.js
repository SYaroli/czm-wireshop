// routes/jobs.js — live, archive, adjust, delete, admin tools
const express = require('express');
const router = express.Router();
const db = require('../db');

// Admins via env: ADMIN_USERS=shane.yaroli,giuliano.clo
const ADMIN_USERS = (process.env.ADMIN_USERS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const currentUser = req => (req.header('x-user') || '').toLowerCase();
const requireAdmin = (req, res, next) =>
  ADMIN_USERS.includes(currentUser(req)) ? next() : res.status(403).json({ error: 'Admin only' });

// helpers
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
    SELECT a.* FROM jobs_adjustments a
    JOIN (SELECT archiveId, MAX(id) AS maxId FROM jobs_adjustments GROUP BY archiveId) m
      ON a.archiveId = m.archiveId AND a.id = m.maxId
  `;
  db.all(sql, [], cb);
}

// LIVE: create
router.post('/log', (req, res) => {
  const { username, partNumber, action, note, startTime, endTime } = req.body || {};
  if (!username || !partNumber || !action) return res.status(400).json({ error: 'Missing required fields' });
  const stmt = `
    INSERT INTO jobs (username, partNumber, action, note, startTime, endTime, pauseStart, pauseTotal, autoPaused)
    VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 0)
  `;
  db.run(stmt, [username, partNumber, action, note || '', startTime || Date.now(), endTime || null], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    db.get(`SELECT * FROM jobs WHERE id = ?`, [this.lastID], (e, row) => {
      if (e) return res.status(500).json({ error: e.message });
      res.json({ success: true, id: this.lastID, log: row });
    });
  });
});

// LIVE: update/pause/continue/finish -> ARCHIVE
router.put('/log/:id', (req, res) => {
  const id = req.params.id;
  const { action, endTime, note, autoPause } = req.body || {}; // autoPause: 0,1,2
  db.get(`SELECT * FROM jobs WHERE id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Log not found' });

    const now = Date.now();
    let stmt = `UPDATE jobs SET action = ?`;
    const params = [action || row.action];
    if (typeof note !== 'undefined') { stmt += `, note = ?`; params.push(String(note || '')); }
    if (action === 'Pause' && !row.pauseStart) {
      stmt += `, pauseStart = ?, autoPaused = ?`; params.push(now, Number(autoPause || 0));
    } else if (action === 'Continue' && row.pauseStart) {
      const paused = now - row.pauseStart;
      stmt += `, pauseTotal = pauseTotal + ?, pauseStart = NULL, autoPaused = 0`; params.push(paused);
    }

    const finishing = action === 'Finish' || !!endTime;
    if (!finishing) {
      db.run(stmt + ` WHERE id = ?`, [...params, id], (e2) => {
        if (e2) return res.status(500).json({ error: 'Failed to update log', details: e2.message });
        db.get(`SELECT * FROM jobs WHERE id = ?`, [id], (e3, out) => {
          if (e3) return res.status(500).json({ error: e3.message });
          res.json({ success: true, log: out });
        });
      });
      return;
    }

    // finish and archive
    const totals = finalizeTotals(row, endTime);
    stmt += `, endTime = ?, pauseStart = NULL, pauseTotal = ?, autoPaused = 0`;
    params.push(totals.endTime, totals.pauseTotal);

    db.run(stmt + ` WHERE id = ?`, [...params, id], function (e2) {
      if (e2) return res.status(500).json({ error: 'Failed to update before archive', details: e2.message });
      db.get(`SELECT * FROM jobs WHERE id = ?`, [id], (e3, r) => {
        if (e3) return res.status(500).json({ error: e3.message });
        const totalActive = Math.max(0, (r.endTime - (r.startTime || r.endTime)) - (r.pauseTotal || 0));
        const ins = `
          INSERT INTO jobs_archive (sourceId, username, partNumber, note, startTime, endTime, pauseTotal, totalActive)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;
        db.run(ins, [r.id, r.username, r.partNumber, r.note || '', r.startTime || r.endTime, r.endTime, r.pauseTotal || 0, totalActive], function (e4) {
          if (e4) return res.status(500).json({ error: 'Archive insert failed', details: e4.message });
          const insertId = this.lastID;
          db.run(`DELETE FROM jobs WHERE id = ?`, [id], (e5) => {
            if (e5) return res.status(500).json({ error: 'Failed to remove live row after archive' });
            db.get(`SELECT * FROM jobs_archive WHERE id = ?`, [insertId], (e6, archived) => {
              if (e6) return res.status(500).json({ error: e6.message });
              res.json({ success: true, archived: true, archive: archived });
            });
          });
        });
      });
    });
  });
});

// LIVE admin/list
router.get('/logs', requireAdmin, (_req, res) => {
  db.all(`SELECT * FROM jobs ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// LIVE self/list
router.get('/logs/:username', (req, res) => {
  const requester = currentUser(req);
  const target = (req.params.username || '').toLowerCase();
  if (!ADMIN_USERS.includes(requester) && requester !== target) return res.status(403).json({ error: 'Forbidden' });
  db.all(`SELECT * FROM jobs WHERE username = ? ORDER BY id DESC`, [req.params.username], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// LIVE self/admin delete all by user
router.delete('/delete-logs/:username', (req, res) => {
  const requester = currentUser(req);
  const target = (req.params.username || '').toLowerCase();
  if (!ADMIN_USERS.includes(requester) && requester !== target) return res.status(403).json({ error: 'Forbidden' });
  db.run(`DELETE FROM jobs WHERE username = ?`, [req.params.username], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to delete user logs' });
    res.json({ success: true, message: `Logs for ${req.params.username} deleted` });
  });
});

// Admin: delete single live log
router.delete('/log/:id', requireAdmin, (req, res) => {
  db.run(`DELETE FROM jobs WHERE id = ?`, [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to delete log' });
    res.json({ success: true, message: `Log ${req.params.id} deleted` });
  });
});

// Admin: clear all live logs
router.delete('/admin/clear-logs', requireAdmin, (_req, res) => {
  db.run(`DELETE FROM jobs`, (err) => {
    if (err) return res.status(500).json({ error: 'Failed to clear logs' });
    res.json({ success: true, message: 'All logs cleared by admin' });
  });
});

// Admin: reassign live fields
router.post('/log/:id/reassign', requireAdmin, (req, res) => {
  const id = req.params.id;
  const { username, partNumber, note } = req.body || {};
  if (!username && !partNumber && typeof note === 'undefined') {
    return res.status(400).json({ error: 'nothing to update' });
  }
  db.get(`SELECT * FROM jobs WHERE id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Log not found' });

    const updates = [], params = [];
    if (username)   { updates.push('username = ?');   params.push(username); }
    if (partNumber) { updates.push('partNumber = ?'); params.push(partNumber); }
    if (typeof note !== 'undefined') { updates.push('note = ?'); params.push(note || ''); }

    db.run(`UPDATE jobs SET ${updates.join(', ')} WHERE id = ?`, [...params, id], (e2) => {
      if (e2) return res.status(500).json({ error: 'update failed' });
      db.get(`SELECT * FROM jobs WHERE id = ?`, [id], (e3, out) => {
        if (e3) return res.status(500).json({ error: e3.message });
        res.json({ success: true, log: out });
      });
    });
  });
});

// Admin: force finish a live log
router.post('/log/:id/force-finish', requireAdmin, (req, res) => {
  const id = req.params.id;
  const { note } = req.body || {};
  db.get(`SELECT * FROM jobs WHERE id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Log not found' });

    const totals = finalizeTotals(row, Date.now());
    const updateSql = `UPDATE jobs SET action='Finish', endTime=?, pauseStart=NULL, pauseTotal=?, note=?, autoPaused=0 WHERE id=?`;
    db.run(updateSql, [totals.endTime, totals.pauseTotal, note ?? row.note ?? '', id], (e2) => {
      if (e2) return res.status(500).json({ error: 'Failed to finalize' });
      db.get(`SELECT * FROM jobs WHERE id = ?`, [id], (e3, r) => {
        if (e3) return res.status(500).json({ error: e3.message });
        const ins = `
          INSERT INTO jobs_archive (sourceId, username, partNumber, note, startTime, endTime, pauseTotal, totalActive)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;
        db.run(ins, [r.id, r.username, r.partNumber, r.note || '', r.startTime, totals.endTime, totals.pauseTotal, totals.totalActive], function (e4) {
          if (e4) return res.status(500).json({ error: 'Archive insert failed', details: e4.message });
          const insertId = this.lastID;
          db.run(`DELETE FROM jobs WHERE id = ?`, [id], (e5) => {
            if (e5) return res.status(500).json({ error: 'Failed to remove live row after archive' });
            db.get(`SELECT * FROM jobs_archive WHERE id = ?`, [insertId], (e6, archived) => {
              if (e6) return res.status(500).json({ error: e6.message });
              res.json({ success: true, archived: true, archive: archived });
            });
          });
        });
      });
    });
  });
});

// ARCHIVE: list (admin; hide deleted by default)
router.get('/archive', requireAdmin, (req, res) => {
  const showDeleted = String(req.query.showDeleted || '0') === '1';
  const where = showDeleted ? '' : 'WHERE isDeleted = 0';
  db.all(`SELECT * FROM jobs_archive ${where} ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    getLatestAdjustments((e2, adjs = []) => {
      if (e2) return res.status(500).json({ error: e2.message });
      const map = new Map(adjs.map(a => [a.archiveId, a]));
      const merged = rows.map(r => applyAdj(r, map.get(r.id)));
      res.json(merged);
    });
  });
});

// ARCHIVE: add adjustment
router.post('/archive/:id/adjust', requireAdmin, (req, res) => {
  const archiveId = parseInt(req.params.id, 10);
  const { startTime, endTime, pauseTotal, partNumber, note, username, reason } = req.body || {};
  if (!reason) return res.status(400).json({ error: 'reason required' });

  db.get('SELECT * FROM jobs_archive WHERE id = ?', [archiveId], (err, base) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!base || base.isDeleted) return res.status(404).json({ error: 'archive row not found' });

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
    ], function (e2) {
      if (e2) return res.status(500).json({ error: e2.message });
      db.get('SELECT * FROM jobs_adjustments WHERE id = ?', [this.lastID], (e3, adj) => {
        if (e3) return res.status(500).json({ error: e3.message });
        const merged = applyAdj(base, adj);
        res.json({ success: true, adjustmentId: this.lastID, archive: merged });
      });
    });
  });
});

// ARCHIVE: list adjustments
router.get('/archive/:id/adjustments', requireAdmin, (req, res) => {
  db.all('SELECT * FROM jobs_adjustments WHERE archiveId = ? ORDER BY id ASC', [req.params.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ARCHIVE: soft delete + restore
router.post('/archive/:id/delete', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const reason = String((req.body && req.body.reason) || '').trim();
  if (!reason) return res.status(400).json({ error: 'reason required' });
  const u = currentUser(req);
  const now = Date.now();
  db.run(
    `UPDATE jobs_archive SET isDeleted = 1, deletedAt = ?, deletedBy = ?, deleteReason = ? WHERE id = ? AND isDeleted = 0`,
    [now, u, reason, id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: 'not found or already deleted' });
      res.json({ success: true, id, deletedAt: now, deletedBy: u });
    }
  );
});
router.post('/archive/:id/restore', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.run(
    `UPDATE jobs_archive SET isDeleted = 0, deletedAt = NULL, deletedBy = NULL, deleteReason = NULL WHERE id = ?`,
    [id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: 'not found' });
      res.json({ success: true, id });
    }
  );
});

module.exports = router;
