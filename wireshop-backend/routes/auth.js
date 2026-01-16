const express = require('express');
const router = express.Router();
const db = require('../db');

// Render env var: ADMIN_USERS="Shane.Yaroli,Giuliano.Clo,..."
// Used ONLY for bootstrap recovery if the DB has no matching user row yet.
// If username is in this list and doesn't exist in DB, we'll create it on first successful login.
const ADMIN_USERS = (process.env.ADMIN_USERS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const currentUser = (req) => String(req.header('x-user') || '').trim().toLowerCase();

/**
 * POST /api/auth/login
 * body: { username, pin }
 * returns: { id, username, role, active, bootstrapped? }
 */
router.post('/login', (req, res) => {
  const { username, pin } = req.body || {};
  if (!username || !pin) return res.status(400).json({ error: 'username and pin required' });

  const u = String(username).trim().toLowerCase();
  const p = String(pin).trim();

  db.get(
    'SELECT id, username, pin, role, active FROM users WHERE username = ? COLLATE NOCASE',
    [u],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });

      // Bootstrap: if DB is missing the admin user, let ADMIN_USERS recreate themselves once.
      if (!row) {
        if (!ADMIN_USERS.includes(u)) return res.status(401).json({ error: 'Invalid username or PIN' });

        db.run(
          'INSERT INTO users (username, pin, role, active) VALUES (?, ?, ?, 1)',
          [u, p, 'admin'],
          function (insErr) {
            if (insErr) return res.status(500).json({ error: insErr.message });
            return res.json({
              id: this.lastID,
              username: u,
              role: 'admin',
              active: 1,
              bootstrapped: true,
            });
          }
        );
        return;
      }

      if (!row.active) return res.status(403).json({ error: 'User inactive' });
      if (String(row.pin) !== p) return res.status(401).json({ error: 'Invalid username or PIN' });

      return res.json({
        id: row.id,
        username: row.username,
        role: row.role,
        active: row.active,
      });
    }
  );
});

/**
 * GET /api/auth/me
 * Header: x-user: <username>
 * returns: { id, username, role, active, isAdmin }
 */
router.get('/me', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Missing x-user' });

  db.get(
    'SELECT id, username, role, active FROM users WHERE username = ? COLLATE NOCASE',
    [u],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'User not found' });
      if (!row.active) return res.status(403).json({ error: 'User inactive' });

      const role = String(row.role || '').toLowerCase();
      return res.json({
        id: row.id,
        username: row.username,
        role,
        active: !!row.active,
        isAdmin: role === 'admin',
      });
    }
  );
});

module.exports = router;
