// server.js
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { initDB, getDB } from './db.js';
import jobsRouter from './routes/jobs.js';
import usersRouter from './routes/users.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ---------- Init DB ----------
initDB();

// ---------- CORS / JSON ----------
app.use(cors({ origin: '*', credentials: false }));
app.use(express.json());

// ---------- Auth middleware (JWT) ----------
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

export function authOptional(req, _res, next) {
  const hdr = req.headers['authorization'] || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = { id: payload.id, username: payload.username, role: payload.role };
    } catch {
      // ignore; route can still read legacy x-user if needed
      req.user = null;
    }
  }
  next();
}

export function authRequired(req, res, next) {
  authOptional(req, res, () => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    next();
  });
}

export function adminRequired(req, res, next) {
  authOptional(req, res, () => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    next();
  });
}

app.use(authOptional);

// ---------- Bootstrap admin if users table empty ----------
import bcrypt from 'bcryptjs';
(async function bootstrapAdmin() {
  const db = getDB();
  const row = await new Promise(r => db.get('SELECT COUNT(*) as n FROM users', (e, x) => r(x || { n: 0 })));
  if (row.n === 0) {
    const username = (process.env.BOOT_ADMIN_USER || 'admin').toLowerCase();
    const pin = process.env.BOOT_ADMIN_PIN || '1234';
    const hash = await bcrypt.hash(pin, 10);
    await new Promise((resolve, reject) =>
      db.run(
        `INSERT INTO users (username, pin_hash, role, active, created_at) VALUES (?, ?, 'admin', 1, ?)`,
        [username, hash, Date.now()],
        (err) => (err ? reject(err) : resolve())
      )
    );
    console.log(`[bootstrap] Created admin user "${username}". Set BOOT_ADMIN_USER/BOOT_ADMIN_PIN to customize.`);
  }
  db.close();
})().catch(console.error);

// ---------- Routes ----------
app.use('/api/jobs', jobsRouter({ adminRequired, authRequired }));
app.use('/api/users', usersRouter({ JWT_SECRET, authRequired, adminRequired }));

// ---------- Health ----------
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Wireshop backend listening on ${PORT}`));
