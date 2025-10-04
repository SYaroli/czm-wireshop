// routes/inventory.js
const express = require('express');
const router = express.Router();
const db = require('../db');

// ---------- auth helpers ----------
function currentUser(req) {
  return (req.header('x-user') || '').trim();
}
function requireUser(req, res, next){
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'x-user required' });
  req.user = u;
  next();
}
function isAdminRole(val) { return String(val || '').toLowerCase() === 'admin'; }
function requireAdmin(req, res, next){
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'x-user required' });
  db.get(
    `SELECT role FROM users WHERE username = ? COLLATE NOCASE`,
    [u],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(403).json({ error: `Admin only (no such user: ${u})` });
      if (!isAdminRole(row.role)) return res.status(403).json({ error: `Admin only (role=${row.role})` });
      req.user = u;
      next();
    }
  );
}

// ---------- helpers ----------
function getOne(partNumber) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT partNumber, qty, updatedAt, updatedBy FROM inventory WHERE partNumber = ?`,
      [partNumber],
      (err, row) => err ? reject(err) : resolve(row || null)
    );
  });
}
function upsert(partNumber, qty, user) {
  const now = Date.now();
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO inventory (partNumber, qty, updatedAt, updatedBy)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(partNumber) DO UPDATE SET
         qty = excluded.qty,
         updatedAt = excluded.updatedAt,
         updatedBy = excluded.updatedBy`,
      [partNumber, qty, now, user],
      (err) => err ? reject(err) : resolve()
    );
  });
}
function insertTxn(partNumber, delta, before, after, note, user) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO inventory_txns (partNumber, delta, qtyBefore, qtyAfter, note, user, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [partNumber, delta, before, after, note || '', user, Date.now()],
      function(err){ return err ? reject(err) : resolve(this.lastID); }
    );
  });
}

// ---------- API: snapshot ----------
router.get('/inventory/:part', requireUser, async (req, res) => {
  try {
    const part = String(req.params.part).trim();
    const row = await getOne(part);
    res.json(row || { partNumber: part, qty: 0, updatedAt: null, updatedBy: null });
  } catch {
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

// ---------- API: adjust ----------
router.post('/inventory/:part/adjust', requireUser, async (req, res) => {
  try {
    const part = String(req.params.part).trim();
    const delta = parseInt(req.body?.delta, 10);
    const note  = String(req.body?.note || '');
    if (!Number.isInteger(delta) || delta === 0) {
      return res.status(400).json({ error: 'delta must be a non-zero integer' });
    }
    const current = await getOne(part) || { qty: 0 };
    const before = current.qty | 0;
    const after  = before + delta;
    if (after < 0) return res.status(400).json({ error: 'resulting qty cannot be negative' });

    await upsert(part, after, req.user);
    await insertTxn(part, delta, before, after, note, req.user);

    res.json({ ok: true, partNumber: part, qty: after, updatedBy: req.user, updatedAt: Date.now() });
  } catch {
    res.status(500).json({ error: 'Failed to adjust inventory' });
  }
});

// ---------- API: recent txns ----------
router.get('/inventory/:part/txns', requireUser, (req, res) => {
  const part = String(req.params.part).trim();
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
  db.all(
    `SELECT id, delta, qtyBefore, qtyAfter, note, user, ts
     FROM inventory_txns
     WHERE partNumber = ?
     ORDER BY id DESC
     LIMIT ?`,
    [part, limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to list txns' });
      res.json(rows);
    }
  );
});

// ---------- API: admin list (locked) ----------
router.get('/inventory', requireAdmin, (_req, res) => {
  db.all(
    `SELECT partNumber, qty, updatedAt, updatedBy
     FROM inventory
     ORDER BY partNumber COLLATE NOCASE ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to list inventory' });
      res.json(rows || []);
    }
  );
});
// ---------- API: delete a txn (admin only; does not alter current qty) ----------
router.delete('/inventory/txns/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
  db.run(`DELETE FROM inventory_txns WHERE id = ?`, [id], function(err){
    if (err) return res.status(500).json({ error: 'Failed to delete txn' });
    if (this.changes === 0) return res.status(404).json({ error: 'not found' });
    res.json({ success: true, id });
  });
});


// ---------- API: list for any logged-in user (read-only) ----------
router.get('/inventory-all', requireUser, (_req, res) => {
  db.all(
    `SELECT partNumber, qty, updatedAt, updatedBy
     FROM inventory
     ORDER BY partNumber COLLATE NOCASE ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to list inventory' });
      res.json(rows || []);
    }
  );
});

module.exports = router;
