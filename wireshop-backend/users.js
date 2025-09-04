// routes/users.js — DB-backed users + admin CRUD
const express = require('express');
const router = express.Router();
const db = require('../db');

const ADMIN_USERS = (process.env.ADMIN_USERS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const currentUser = req => (req.header('x-user') || '').toLowerCase();
const requireAdmin = (req, res, next) =>
  ADMIN_USERS.includes(currentUser(req)) ? next() : res.status(403).json({ error: 'Admin only' });

// Login against DB users
router.post('/login', (req, res) => {
  const { username, pin } = req.body || {};
  if (!username || !pin) return res.status(400).json({ error: 'username and pin required' });
  db.get(
    `SELECT username, role FROM users WHERE username = ? COLLATE NOCASE AND pin = ?`,
    [String(username), String(pin)],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(401).json({ error: 'Invalid' });
      res.json(row);
    }
  );
});

// Admin: list/add/delete
router.get('/', requireAdmin, (_req, res) => {
  db.all(`SELECT id, username, role FROM users ORDER BY username COLLATE NOCASE ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});
router.post('/', requireAdmin, (req, res) => {
  const { username, pin, role } = req.body || {};
  if (!username || !pin || !role) return res.status(400).json({ error: 'username, pin, role required' });
  db.run(
    `INSERT INTO users (username, pin, role) VALUES (?, ?, ?)`,
    [String(username), String(pin), String(role)],
    function (err) {
      if (err) {
        if (String(err.message||'').includes('UNIQUE')) return res.status(409).json({ error: 'username exists' });
        return res.status(500).json({ error: err.message });
      }
      db.get(`SELECT id, username, role FROM users WHERE id = ?`, [this.lastID], (e, row) => {
        if (e) return res.status(500).json({ error: e.message });
        res.json({ success: true, user: row });
      });
    }
  );
});
router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.run(`DELETE FROM users WHERE id = ?`, [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'not found' });
    res.json({ success: true, id });
  });
});

module.exports = router;
