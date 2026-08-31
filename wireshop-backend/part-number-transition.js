const express = require('express');
const dbDefault = require('./db');

module.exports = function attachPartNumberTransition(app, opts = {}) {
  const db = opts.db || dbDefault;
  const router = express.Router();

  const run = (sql, args = []) => new Promise((resolve, reject) => {
    db.run(sql, args, function (err) {
      if (err) reject(err);
      else resolve({ changes: this.changes || 0, lastID: this.lastID });
    });
  });

  const get = (sql, args = []) => new Promise((resolve, reject) => {
    db.get(sql, args, (err, row) => err ? reject(err) : resolve(row || null));
  });

  function username(req) {
    return String(req.headers['x-user'] || '').trim().toLowerCase();
  }

  async function requireAdmin(req, res) {
    const user = username(req);
    if (!user) {
      res.status(401).json({ error: 'x-user required' });
      return null;
    }

    const row = await get(
      `SELECT role FROM users WHERE username = ? COLLATE NOCASE`,
      [user]
    );

    if (!row || String(row.role || '').toLowerCase() !== 'admin') {
      res.status(403).json({ error: 'admin only' });
      return null;
    }

    return user;
  }

  // Changes the CURRENT part number without rewriting completed history.
  // Inventory movement before the transition stays under the old part number.
  // Queued/in-progress Build Next tasks move to the new part number in place,
  // so startedAt / pause data / elapsed timing are untouched.
  router.post('/api/part-number-transition', async (req, res) => {
    let user;
    try {
      user = await requireAdmin(req, res);
      if (!user) return;
    } catch (e) {
      return res.status(500).json({ error: 'db error', detail: String(e.message || e) });
    }

    const oldPartNumber = String(req.body?.oldPartNumber || '').trim();
    const newPartNumber = String(req.body?.newPartNumber || '').trim();

    if (!oldPartNumber || !newPartNumber) {
      return res.status(400).json({ error: 'oldPartNumber and newPartNumber are required' });
    }
    if (oldPartNumber.toLowerCase() === newPartNumber.toLowerCase()) {
      return res.status(400).json({ error: 'new part number must be different' });
    }

    try {
      const oldInventory = await get(
        `SELECT partNumber, qty FROM inventory WHERE partNumber = ? COLLATE NOCASE`,
        [oldPartNumber]
      );
      if (!oldInventory) return res.status(404).json({ error: 'current inventory part not found' });

      const newInventory = await get(
        `SELECT partNumber FROM inventory WHERE partNumber = ? COLLATE NOCASE`,
        [newPartNumber]
      );
      if (newInventory) {
        return res.status(409).json({
          error: 'new part number already exists in inventory; automatic transition stopped to avoid merging records'
        });
      }

      const ts = Date.now();
      const qty = Number(oldInventory.qty) || 0;

      await run('BEGIN IMMEDIATE');
      try {
        const inv = await run(
          `UPDATE inventory
              SET partNumber = ?, updatedAt = ?, updatedBy = ?
            WHERE partNumber = ? COLLATE NOCASE`,
          [newPartNumber, ts, user, oldPartNumber]
        );
        if (inv.changes !== 1) throw new Error('inventory transition conflict');

        // Only current work changes. Completed Build History remains exactly as recorded.
        const tasks = await run(
          `UPDATE build_tasks
              SET partNumber = ?
            WHERE partNumber = ? COLLATE NOCASE
              AND status IN ('queued', 'claimed')`,
          [newPartNumber, oldPartNumber]
        );

        // Start the new part's movement record with a zero-delta transition marker.
        // Older movement rows intentionally remain under the old part number.
        await run(
          `INSERT INTO inventory_log
             (partNumber, ts, user, delta, qtyBefore, qtyAfter, note)
           VALUES (?, ?, ?, 0, ?, ?, ?)`,
          [
            newPartNumber,
            ts,
            user,
            qty,
            qty,
            `Part number changed from ${oldPartNumber} to ${newPartNumber}. Previous movement history remains under ${oldPartNumber}.`
          ]
        );

        await run('COMMIT');

        return res.json({
          ok: true,
          oldPartNumber,
          newPartNumber,
          qty,
          activeTasksUpdated: tasks.changes,
          completedHistoryChanged: false,
          previousMovementHistoryChanged: false
        });
      } catch (e) {
        try { await run('ROLLBACK'); } catch {}
        throw e;
      }
    } catch (e) {
      console.error('[part-number-transition]', e);
      return res.status(500).json({ error: 'transition failed', detail: String(e.message || e) });
    }
  });

  app.use(router);
};
