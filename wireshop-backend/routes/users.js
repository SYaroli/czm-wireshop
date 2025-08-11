// routes/users.js
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getDB } from '../db.js';

export default function usersRouterFactory({ JWT_SECRET, authRequired, adminRequired }) {
  const router = express.Router();

  // POST /api/users/login  { username, pin }
  router.post('/login', async (req, res) => {
    try {
      const username = String(req.body.username || '').toLowerCase().trim();
      const pin = String(req.body.pin || '').trim();
      if (!username || !pin) return res.status(400).json({ error: 'Missing credentials' });

      const db = getDB();
      const user = await new Promise((resolve) =>
        db.get('SELECT * FROM users WHERE username = ? AND active = 1', [username], (_e, row) => resolve(row))
      );
      db.close();
      if (!user) return res.status(401).json({ error: 'Invalid username or PIN' });

      const ok = await bcrypt.compare(pin, user.pin_hash);
      if (!ok) return res.status(401).json({ error: 'Invalid username or PIN' });

      const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: '12h' }
      );
      return res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // ----- Admin: CRUD users (no hash leakage) -----

  // List users
  router.get('/', adminRequired, async (_req, res) => {
    const db = getDB();
    const rows = await new Promise((resolve) =>
      db.all('SELECT id, username, role, active, created_at FROM users ORDER BY username', (_e, r) => resolve(r || []))
    );
    db.close();
    res.json(rows);
  });

  // Create user { username, pin, role }
  router.post('/', adminRequired, async (req, res) => {
    try {
      const username = String(req.body.username || '').toLowerCase().trim();
      const role = req.body.role === 'admin' ? 'admin' : 'assembler';
      const pin = String(req.body.pin || '').trim();
      if (!username || !pin) return res.status(400).json({ error: 'username and pin required' });

      const hash = await bcrypt.hash(pin, 10);
      const db = getDB();
      await new Promise((resolve, reject) =>
        db.run(
          `INSERT INTO users (username, pin_hash, role, active, created_at) VALUES (?, ?, ?, 1, ?)`,
          [username, hash, role, Date.now()],
          (err) => (err ? reject(err) : resolve())
        )
      );
      db.close();
      res.status(201).json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: 'Could not create user (maybe duplicate username?)' });
    }
  });

  // Update user (role, active; optional pin reset)
  router.put('/:id', adminRequired, async (req, res) => {
    const id = Number(req.params.id);
    const role = req.body.role === 'admin' ? 'admin' : 'assembler';
    const active = req.body.active ? 1 : 0;
    const pin = req.body.pin ? String(req.body.pin) : null;

    const db = getDB();
    try {
      if (pin) {
        const hash = await bcrypt.hash(pin, 10);
        await new Promise((resolve, reject) =>
          db.run(`UPDATE users SET role=?, active=?, pin_hash=? WHERE id=?`, [role, active, hash, id],
            (err) => (err ? reject(err) : resolve()))
        );
      } else {
        await new Promise((resolve, reject) =>
          db.run(`UPDATE users SET role=?, active=? WHERE id=?`, [role, active, id],
            (err) => (err ? reject(err) : resolve()))
        );
      }
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: 'Update failed' });
    } finally {
      db.close();
    }
  });

  // Delete
  router.delete('/:id', adminRequired, async (req, res) => {
    const id = Number(req.params.id);
    const db = getDB();
    await new Promise((resolve, reject) =>
      db.run(`DELETE FROM users WHERE id=?`, [id], (err) => (err ? reject(err) : resolve()))
    );
    db.close();
    res.json({ ok: true });
  });

  return router;
}
