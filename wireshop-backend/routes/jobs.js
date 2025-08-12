// routes/jobs.js
const express = require('express');
const router = express.Router();
const db = require('../db');

// ----- Admin list via env var -----
// In Render, set ADMIN_USERS like:  shane,giuliano
const ADMIN_USERS = (process.env.ADMIN_USERS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function currentUser(req) {
  return (req.header('x-user') || '').toLowerCase();
}

function requireAdmin(req, res, next) {
  const u = currentUser(req);
  if (ADMIN_USERS.includes(u)) return next();
  return res.status(403).json({ error: 'Admin only' });
}

// Create log
router.post('/log', (req, res) => {
  const { username, partNumber, action, note, startTime, endTime } = req.body;
  if (!username || !partNumber || !action) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const stmt = `
    INSERT INTO jobs (username, partNumber, action, note, startTime, endTime, pauseStart, pauseTotal)
    VALUES (?, ?, ?, ?, ?, ?, NULL, 0)
  `;
  db.run(stmt, [username, partNumber, action, note || '', startTime || null, endTime || null], function (err) {
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

  db.get(`SELECT * FROM jobs WHERE id = ? AND endTime IS NULL`, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Log not found or already completed' });

    const now = Date.now();
    let stmt = `UPDATE jobs SET action = ?`;
    let params = [action || row.action];

    if (endTime) {
      stmt += `, endTime = ?`;
      params.push(endTime);
    }

    if (action === 'Pause' && !row.pauseStart) {
      stmt += `, pauseStart = ?`;
      params.push(now);
    } else if (action === 'Continue' && row.pauseStart) {
      const paused = now - row.pauseStart;
      stmt += `, pauseTotal = pauseTotal + ?, pauseStart = NULL`;
      params.push(paused);
    }

    stmt += ` WHERE id = ?`;
    params.push(id);

    db.run(stmt, params, (err) => {
      if (err) return res.status(500).json({ error: 'Failed to update log', details: err.message });
      db.get(`SELECT * FROM jobs WHERE id = ?`, [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, log: row });
      });
    });
  });
});

// Admin: get all logs
router.get('/logs', requireAdmin, (req, res) => {
  db.all(`SELECT * FROM jobs ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Self or admin: get logs for a username
router.get('/logs/:username', (req, res) => {
  const requester = currentUser(req);
  const target = (req.params.username || '').toLowerCase();
  const isAdmin = ADMIN_USERS.includes(requester);
  const isSelf = requester === target;

  if (!isAdmin && !isSelf) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  db.all(`SELECT * FROM jobs WHERE username = ? ORDER BY id DESC`, [req.params.username], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Self or admin: delete all logs for a username
router.delete('/delete-logs/:username', (req, res) => {
  const requester = currentUser(req);
  const target = (req.params.username || '').toLowerCase();
  const isAdmin = ADMIN_USERS.includes(requester);
  const isSelf = requester === target;

  if (!isAdmin && !isSelf) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  db.run(`DELETE FROM jobs WHERE username = ?`, [req.params.username], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to delete user logs' });
    res.json({ success: true, message: `Logs for ${req.params.username} deleted` });
  });
});

// Admin: delete one log by id
router.delete('/log/:id', requireAdmin, (req, res) => {
  db.run(`DELETE FROM jobs WHERE id = ?`, [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to delete log' });
    res.json({ success: true, message: `Log ${req.params.id} deleted` });
  });
});

// Admin: clear all logs
router.delete('/admin/clear-logs', requireAdmin, (req, res) => {
  db.run(`DELETE FROM jobs`, (err) => {
    if (err) return res.status(500).json({ error: 'Failed to clear logs' });
    res.json({ success: true, message: 'All logs cleared by admin' });
  });
});

module.exports = router;
