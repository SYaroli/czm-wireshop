// routes/inventory.js
const express = require('express');
const router = express.Router();
const db = require('../db');

function requireUser(req, res, next){
  const u = (req.header('x-user') || '').trim();
  if (!u) return res.status(401).json({ error: 'x-user required' });
  req.user = u;
  next();
}

// Helpers
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

// GET current snapshot
router.get('/inventory/:part', requireUser, async (req, res) => {
  try {
    const part = String(req.params.part).trim();
    const row = await getOne(part);
    res.json(row || { partNumber: part, qty: 0, updatedAt: null, updatedBy: null });
  } catch {
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

// POST adjust { delta, note }
router.post('/inventory/:part/adjust', requireUser, async (req, res) => {
  try {
    const part = String(req.params.part).trim();
    const delta = parseInt(req.body?.delta, 10);
    const note  = String(req.body?.note || '');
    if (!Number.isFinite(delta) || delta === 0) {
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

// GET recent txns
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

module.exports = router;
