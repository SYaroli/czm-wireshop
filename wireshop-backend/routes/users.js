// wireshop-backend/routes/users.js
const express = require('express');
const router = express.Router();
const db = require('../db');

const ADMIN_USERS = (process.env.ADMIN_USERS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const currentUser = (req) => String(req.header('x-user') || '').trim().toLowerCase();

function isAdminUsername(username, cb) {
  if (!username) return cb(null, false);

  // Bootstrap admins (optional). Lets you regain admin if DB gets borked.
  if (ADMIN_USERS.includes(username)) return cb(null, true);

  // Real source of truth: DB role + active
  db.get(
    `SELECT role, active FROM users WHERE username = ? COLLATE NOCASE`,
    [username],
    (err, row) => {
      if (err) return cb(err);
      const ok =
        !!row &&
        Number(row.active) === 1 &&
        String(row.role || '').toLowerCase() === 'admin';
      cb(null, ok);
    }
  );
}

function requireAdmin(req, res, next) {
  const u = currentUser(req);
  isAdminUsername(u, (err, ok) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!ok) return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

// LOGIN: must be active
router.post('/login', (req, res) => {
  const { username, pin } = req.body || {};
  if (!username || !pin) return res.status(400).json({ error: 'username and pin required' });

  db.get(
    `SELECT username, role, active
       FROM users
      WHERE username = ? COLLATE NOCASE
        AND pin = ?`,
    [String(username), String(pin)],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(401).json({ error: 'Invalid' });
      if (Number(row.active) !== 1) return res.status(403).json({ error: 'Account disabled' });
      res.json({ username: row.username, role: row.role });
    }
  );
});

// ADMIN: list users
router.get('/', requireAdmin, (_req, res) => {
  db.all(
    `SELECT id, username, role, active
       FROM users
   ORDER BY username COLLATE NOCASE ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ADMIN: create user
router.post('/', requireAdmin, (req, res) => {
  const { username, pin, role } = req.body || {};
  if (!username || !pin) return res.status(400).json({ error: 'username and pin required' });

  const finalRole = String(role || 'tech').toLowerCase();
  const allowed = new Set(['admin', 'tech']);
  if (!allowed.has(finalRole)) return res.status(400).json({ error: 'Invalid role' });

  db.run(
    `INSERT INTO users (username, pin, role, active) VALUES (?, ?, ?, 1)`,
    [String(username), String(pin), finalRole],
    function (err) {
      if (err) {
        if (String(err.message || '').includes('UNIQUE')) {
          return res.status(409).json({ error: 'username exists' });
        }
        return res.status(500).json({ error: err.message });
      }
      db.get(
        `SELECT id, username, role, active FROM users WHERE id = ?`,
        [this.lastID],
        (e, row) => {
          if (e) return res.status(500).json({ error: e.message });
          res.json({ success: true, user: row });
        }
      );
    }
  );
});

// ADMIN: update user (role, active, pin reset)
router.patch('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const { pin, role, active } = req.body || {};

  const sets = [];
  const vals = [];

  if (pin != null && String(pin).trim() !== '') {
    sets.push('pin = ?');
    vals.push(String(pin));
  }

  if (role != null) {
    const r = String(role).toLowerCase();
    const allowed = new Set(['admin', 'tech']);
    if (!allowed.has(r)) return res.status(400).json({ error: 'Invalid role' });
    sets.push('role = ?');
    vals.push(r);
  }

  if (active != null) {
    const a = Number(active) ? 1 : 0;
    sets.push('active = ?');
    vals.push(a);
  }

  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  vals.push(id);

  db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'not found' });

    db.get(
      `SELECT id, username, role, active FROM users WHERE id = ?`,
      [id],
      (e, row) => {
        if (e) return res.status(500).json({ error: e.message });
        res.json({ success: true, user: row });
      }
    );
  });
});

// ADMIN: delete user
router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  db.run(`DELETE FROM users WHERE id = ?`, [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'not found' });
    res.json({ success: true, id });
  });
});

module.exports = router;
