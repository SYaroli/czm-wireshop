// routes/inventory.js
const express = require('express');
const router = express.Router();

// You already have a db helper; require it the same way your other routes do
const db = require('../dbjs'); // if your file is named db.js, switch to '../db.js'

// Optional: small auth guard
function requireAdmin(req, res, next) {
  // adapt to your auth shape
  if (req.user && (req.user.role === 'admin' || req.user.isAdmin === 1 || req.user.isAdmin === true)) {
    return next();
  }
  return res.status(403).json({ error: 'admin_only' });
}

/**
 * GET /api/inventory
 * Returns full list
 */
router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT partNumber, printName, location, min, qty, notes, expectedHours, updatedAt, updatedBy
      FROM inventory
      ORDER BY partNumber ASC
    `);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).send('failed');
  }
});

/**
 * POST /api/inventory/:pn/adjust
 * Body: { delta }
 */
router.post('/:pn/adjust', async (req, res) => {
  const pn = req.params.pn;
  const delta = Number(req.body?.delta || 0);
  if (!pn || !delta) return res.status(400).send('bad_request');
  try {
    await db.run(
      `UPDATE inventory SET qty = qty + ?, updatedAt = datetime('now'), updatedBy = ? WHERE partNumber = ?`,
      [delta, req.user?.name || req.user?.email || 'unknown', pn]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).send('failed');
  }
});

/**
 * POST /api/inventory
 * Create new part
 */
router.post('/', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.partNumber) return res.status(400).send('partNumber required');
  try {
    await db.run(`
      INSERT INTO inventory (partNumber, printName, location, min, qty, notes, expectedHours, updatedAt, updatedBy)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    `, [
      b.partNumber.trim(),
      b.printName?.trim() || null,
      b.location?.trim() || null,
      Number(b.min || 0),
      Number(b.qty || 0),
      b.notes?.trim() || null,
      b.expectedHours != null ? Number(b.expectedHours) : null,
      req.user?.name || req.user?.email || 'unknown'
    ]);
    res.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).send('partNumber already exists');
    }
    console.error(e);
    res.status(500).send('failed');
  }
});

/**
 * PUT /api/inventory/:pn
 * Update part (supports changing partNumber)
 */
router.put('/:pn', requireAdmin, async (req, res) => {
  const oldPn = req.params.pn;
  const b = req.body || {};
  if (!b.partNumber) return res.status(400).send('partNumber required');

  const trx = await db.begin();
  try {
    // If part number changes, ensure no collision
    if (b.partNumber.trim() !== oldPn) {
      const exists = await trx.get(`SELECT partNumber FROM inventory WHERE partNumber = ?`, [b.partNumber.trim()]);
      if (exists) {
        await trx.rollback();
        return res.status(409).send('partNumber already exists');
      }
    }

    await trx.run(`
      UPDATE inventory
      SET partNumber = ?, printName = ?, location = ?, min = ?, qty = ?, notes = ?, expectedHours = ?, updatedAt = datetime('now'), updatedBy = ?
      WHERE partNumber = ?
    `, [
      b.partNumber.trim(),
      b.printName?.trim() || null,
      b.location?.trim() || null,
      Number(b.min || 0),
      Number(b.qty || 0),
      b.notes?.trim() || null,
      b.expectedHours != null ? Number(b.expectedHours) : null,
      req.user?.name || req.user?.email || 'unknown',
      oldPn
    ]);

    await trx.commit();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    try { await trx.rollback(); } catch {}
    res.status(500).send('failed');
  }
});

/**
 * DELETE /api/inventory/:pn
 */
router.delete('/:pn', requireAdmin, async (req, res) => {
  const pn = req.params.pn;
  if (!pn) return res.status(400).send('bad_request');
  try {
    const r = await db.run(`DELETE FROM inventory WHERE partNumber = ?`, [pn]);
    if (r.changes === 0) return res.status(404).send('not_found');
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).send('failed');
  }
});

module.exports = router;
