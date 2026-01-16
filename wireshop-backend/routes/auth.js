const express = require('express');
const router = express.Router();
const db = require('../db');

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, pin } = req.body || {};
  const u = String(username || '').trim().toLowerCase();
  const p = String(pin || '').trim();
  if (!u || !p) return res.status(400).json({ error: 'username and pin required' });

  db.get(
    `SELECT username, role, active FROM users WHERE username = ? COLLATE NOCASE`,
    [u],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row || Number(row.active) !== 1) return res.status(401).json({ error: 'Invalid username or PIN' });

      db.get(
        `SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND pin = ?`,
        [u, p],
        (err2, ok) => {
          if (err2) return res.status(500).json({ error: err2.message });
          if (!ok) return res.status(401).json({ error: 'Invalid username or PIN' });
          res.json({ username: row.username, role: String(row.role || 'tech').toLowerCase() });
        }
      );
    }
  );
});

module.exports = router;
