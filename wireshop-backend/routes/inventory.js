// wireshop-backend/routes/inventory.js
const express = require('express');
const router = express.Router();

// Use your real db helper filename
const db = require('../db'); // ← was ../dbjs (wrong)

// Simple admin gate; adapt to your auth if needed
function requireAdmin(req, res, next) {
  if (req.user && (req.user.role === 'admin' || req.user.isAdmin === true || req.user.isAdmin === 1)) {
    return next();
  }
  return res.status(403).json({ error: 'admin_only' });
}

/**
 * GET /api/inventory
 * Note: server mounts this router at /api, so we prefix paths with /inventory here.
 */
router.get('/inventory', async (_req, res) => {
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
router.post('/inventory/:pn/adjust', async (req, res) => {
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
router.post('/inventory', requireAdmin, async (req, res) => {
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
router.put('/inventory/:pn', requireAdmin, async (req, res) => {
  const oldPn = req.params.pn;
  const b = req.body || {};
  if (!b.partNumber) return res.status(400).send('partNumber required');

  const trx = await db.begin?.() || db; // support db.begin() if available; otherwise use db directly
  const usingTrx = !!db.begin;

  try {
    // If part number changes, ensure no collision
    if (b.partNumber.trim() !== oldPn) {
      const exists = await (usingTrx ? trx.get : db.get)(`SELECT partNumber FROM inventory WHERE partNumber = ?`, [b.partNumber.trim()]);
      if (exists) {
        if (usingTrx) await trx.rollback();
        return res.status(409).send('partNumber already exists');
      }
    }

    await (usingTrx ? trx.run : db.run)(`
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

    if (usingTrx) await trx.commit?.();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    try { if (usingTrx) await trx.rollback?.(); } catch {}
    res.status(500).send('failed');
  }
});

/**
 * DELETE /api/inventory/:pn
 */
router.delete('/inventory/:pn', requireAdmin, async (req, res) => {
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
