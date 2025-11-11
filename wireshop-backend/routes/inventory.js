// wireshop-backend/routes/inventory.js
// single source of truth for inventory, DB-backed, admin-only edits

const express = require('express');
const router = express.Router();
const db = require('../db'); // this already points to the persistent DB_PATH on Render

// ----- auth helpers (same pattern as routes/users.js) -----
// start with env list
let ADMIN_USERS = (process.env.ADMIN_USERS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// force-add the two humans who actually use this thing
const builtIns = [
  'shane',
  'shane.yaroli',
  'tyler.ellis',
  'tyler',
];
for (const u of builtIns) {
  if (!ADMIN_USERS.includes(u)) ADMIN_USERS.push(u);
}

function currentUser(req) {
  return (req.header('x-user') || '').trim().toLowerCase();
}

function requireUser(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'x-user required' });
  req.user = u;
  next();
}

function requireAdmin(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'x-user required' });
  if (!ADMIN_USERS.includes(u)) return res.status(403).json({ error: 'admin only' });
  req.user = u;
  next();
}

// ----- ensure table exists / columns exist -----
function ensureInventoryTable() {
  db.run(
    `CREATE TABLE IF NOT EXISTS inventory (
      partNumber TEXT PRIMARY KEY,
      description TEXT,
      location TEXT,
      qty INTEGER DEFAULT 0,
      minQty INTEGER DEFAULT 0,
      notes TEXT,
      updatedAt INTEGER,
      updatedBy TEXT
    )`
  );

  db.all(`PRAGMA table_info(inventory)`, (err, rows = []) => {
    if (err) {
      console.error('PRAGMA inventory failed:', err);
      return;
    }
    const cols = rows.map(r => r.name);
    const addCol = (name, def) => {
      if (!cols.includes(name)) {
        db.run(`ALTER TABLE inventory ADD COLUMN ${name} ${def}`, e => {
          if (e) console.error(`ALTER TABLE inventory add ${name} failed:`, e.message);
        });
      }
    };
    addCol('description', 'TEXT');
    addCol('location', 'TEXT');
    addCol('minQty', 'INTEGER DEFAULT 0');
    addCol('notes', 'TEXT');
    addCol('updatedAt', 'INTEGER');
    addCol('updatedBy', 'TEXT');
  });
}
ensureInventoryTable();

// ----- GET all (for your inventory-list.html) -----
router.get('/inventory-all', requireUser, (_req, res) => {
  db.all(
    `SELECT partNumber, description, location, qty, minQty, notes, updatedAt, updatedBy
     FROM inventory
     ORDER BY partNumber COLLATE NOCASE ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to list inventory' });
      res.json(rows || []);
    }
  );
});

// ----- GET single -----
router.get('/inventory/:partNumber', requireUser, (req, res) => {
  const { partNumber } = req.params;
  db.get(
    `SELECT partNumber, description, location, qty, minQty, notes, updatedAt, updatedBy
     FROM inventory WHERE partNumber = ?`,
    [partNumber],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'DB error' });
      if (!row) return res.status(404).json({ error: 'not found' });
      res.json(row);
    }
  );
});

// ----- CREATE (admin only) -----
router.post('/inventory', requireAdmin, (req, res) => {
  const now = Date.now();
  const {
    partNumber,
    description = '',
    location = '',
    qty = 0,
    minQty = 0,
    notes = ''
  } = req.body || {};

  if (!partNumber) return res.status(400).json({ error: 'partNumber required' });

  db.run(
    `INSERT INTO inventory (partNumber, description, location, qty, minQty, notes, updatedAt, updatedBy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(partNumber).trim(),
      String(description),
      String(location),
      Number(qty) || 0,
      Number(minQty) || 0,
      String(notes),
      now,
      req.user
    ],
    function (err) {
      if (err) {
        if (String(err.message || '').includes('UNIQUE')) {
          return res.status(409).json({ error: 'part already exists' });
        }
        return res.status(500).json({ error: err.message });
      }
      db.get(
        `SELECT partNumber, description, location, qty, minQty, notes, updatedAt, updatedBy
         FROM inventory WHERE partNumber = ?`,
        [partNumber],
        (e, row) => {
          if (e) return res.status(500).json({ error: e.message });
          res.status(201).json(row);
        }
      );
    }
  );
});

// ----- UPDATE whole record (admin only) -----
router.put('/inventory/:partNumber', requireAdmin, (req, res) => {
  const now = Date.now();
  const { partNumber } = req.params;
  const {
    description = '',
    location = '',
    qty = 0,
    minQty = 0,
    notes = ''
  } = req.body || {};

  db.run(
    `UPDATE inventory
     SET description = ?, location = ?, qty = ?, minQty = ?, notes = ?, updatedAt = ?, updatedBy = ?
     WHERE partNumber = ?`,
    [
      String(description),
      String(location),
      Number(qty) || 0,
      Number(minQty) || 0,
      String(notes),
      now,
      req.user,
      partNumber
    ],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: 'not found' });
      db.get(
        `SELECT partNumber, description, location, qty, minQty, notes, updatedAt, updatedBy
         FROM inventory WHERE partNumber = ?`,
        [partNumber],
        (e, row) => {
          if (e) return res.status(500).json({ error: e.message });
          res.json(row);
        }
      );
    }
  );
});

// ----- DELETE (admin only) -----
router.delete('/inventory/:partNumber', requireAdmin, (req, res) => {
  const { partNumber } = req.params;
  db.run(
    `DELETE FROM inventory WHERE partNumber = ?`,
    [partNumber],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true });
    }
  );
});

// ----- adjust qty (non-admins can do counts) -----
router.post('/inventory/:partNumber/qty', requireUser, (req, res) => {
  const { partNumber } = req.params;
  const { qty } = req.body || {};
  const newQty = Number(qty);
  if (Number.isNaN(newQty)) return res.status(400).json({ error: 'qty must be number' });

  const now = Date.now();
  db.run(
    `UPDATE inventory
     SET qty = ?, updatedAt = ?, updatedBy = ?
     WHERE partNumber = ?`,
    [newQty, now, req.user, partNumber],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: 'not found' });
      db.get(
        `SELECT partNumber, description, location, qty, minQty, notes, updatedAt, updatedBy
         FROM inventory WHERE partNumber = ?`,
        [partNumber],
        (e, row) => {
          if (e) return res.status(500).json({ error: e.message });
          res.json(row);
        }
      );
    }
  );
});

module.exports = router;
