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

// Helpers
function finalizeTotals(row, explicitEndTime) {
  const now = explicitEndTime || Date.now();
  let pauseTotal = row.pauseTotal || 0;
  if (row.pauseStart) pauseTotal += (now - row.pauseStart);
  const totalActive = Math.max(0, (now - (row.startTime || now)) - pauseTotal);
  return { endTime: now, pauseTotal, totalActive };
}

// Create log (live)
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

// Update log (pause/continue/finish)
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

    // If finishing: compute totals, archive snapshot, then delete from live
    if (action === 'Finish' || endTime) {
      const totals = finalizeTotals(row, endTime);
      stmt += `, endTime = ?, pauseStart = NULL, pauseTotal = ?`;
      params.push(totals.endTime, totals.pauseTotal);

      db.run(stmt + ` WHERE id = ?`, [...params, id], (err2) => {
        if (err2) return res.status(500).json({ error: 'Failed to update before archive', details: err2.message });

        // Re-read the finalized row
        db.get(`SELECT * FROM jobs WHERE id = ?`, [id], (err3, r) => {
          if (err3) return res.status(500).json({ error: err3.message });
          const fin = finalizeTotals(r, r.endTime || now);

          // Write to archive
          const ins = `
            INSERT INTO jobs_archive (sourceId, username, partNumber, note, startTime, endTime, pauseTotal, totalActive)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `;
          db.run(ins, [r.id, r.username, r.partNumber, r.note || '', r.startTime || now, fin.endTime, fin.pauseTotal, fin.totalActive], function (err4) {
            if (err4) return res.status(500).json({ error: 'Archive insert failed', details: err4.message });

            // Remove from live
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
      return; // done in the finish branch
    }

    // Regular pause/continue path
    db.run(stmt + ` WHERE id = ?`, [...params, id], (err2) => {
      if (err2) return res.status(500).json({ error: 'Failed to update log', details: err2.message });
      db.get(`SELECT * FROM jobs WHERE id = ?`, [id], (err3, out) => {
        if (err3) return res.status(500).json({ error: err3.message });
        res.json({ success: true, log: out });
      });
    });
  });
});

// Admin: current live items
router.get('/logs', requireAdmin, (req, res) => {
  db.all(`SELECT * FROM jobs ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Self or admin: user-specific live logs
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

// Admin: archive read (for the new Review page)
router.get('/archive', requireAdmin, (req, res) => {
  db.all(`SELECT * FROM jobs_archive ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Admin: delete one live log
router.delete('/log/:id', requireAdmin, (req, res) => {
  db.run(`DELETE FROM jobs WHERE id = ?`, [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to delete log' });
    res.json({ success: true, message: `Log ${req.params.id} deleted` });
  });
});

// Admin: clear ALL live logs (does not touch archive)
router.delete('/admin/clear-logs', requireAdmin, (req, res) => {
  db.run(`DELETE FROM jobs`, (err) => {
    if (err) return res.status(500).json({ error: 'Failed to clear logs' });
    res.json({ success: true, message: 'All live logs cleared by admin' });
  });
});

module.exports = router;
