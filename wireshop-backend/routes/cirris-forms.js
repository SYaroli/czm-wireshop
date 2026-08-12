// routes/cirris-forms.js
// Store, create, replace, and download Cirris setup workbooks by harness part number.

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const db = require('../db');

const ADMIN_USERS = (process.env.ADMIN_USERS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const currentUser = req => (req.header('x-user') || 'unknown').trim().toLowerCase();

function requireUser(req, res, next) {
  const username = currentUser(req);
  if (!username || username === 'unknown') return res.status(401).json({ error: 'x-user required' });
  req.user = username;
  next();
}

function requireAdmin(req, res, next) {
  const username = currentUser(req);
  if (ADMIN_USERS.includes(username)) {
    req.user = username;
    return next();
  }

  db.get(
    `SELECT role FROM users WHERE LOWER(username) = ? AND active = 1`,
    [username],
    (err, row) => {
      if (err || !row || String(row.role || '').toLowerCase() !== 'admin') {
        return res.status(403).json({ error: 'Admin only' });
      }
      req.user = username;
      next();
    }
  );
}

// Kept here instead of db.js so this feature is self-contained and safe to deploy independently.
db.run(`CREATE TABLE IF NOT EXISTS cirris_forms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  part_number TEXT    NOT NULL,
  filename    TEXT    NOT NULL,
  file_data   BLOB    NOT NULL,
  file_size   INTEGER,
  uploaded_by TEXT    NOT NULL,
  uploaded_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  source      TEXT    NOT NULL DEFAULT 'upload'
)`);

db.run(`CREATE INDEX IF NOT EXISTS idx_cirris_forms_part_id
          ON cirris_forms(part_number, id DESC)`);

function getBlankTemplateBuffer() {
  const templatePath = path.join(__dirname, '..', 'templates', 'cirris-setup-blank.b64');
  const b64 = fs.readFileSync(templatePath, 'utf8').trim();
  return Buffer.from(b64, 'base64');
}

function safeFilenamePart(partNumber) {
  return String(partNumber || '').trim().replace(/[\\/:*?"<>|]/g, '_');
}

// Latest form metadata for a part number.
router.get('/check', requireUser, (req, res) => {
  const pn = String(req.query.part_number || '').trim();
  if (!pn) return res.json({ exists: false });

  db.get(
    `SELECT id, part_number, filename, file_size, uploaded_by, uploaded_at, source
       FROM cirris_forms
      WHERE part_number = ?
      ORDER BY id DESC
      LIMIT 1`,
    [pn],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(row ? { exists: true, file: row } : { exists: false });
    }
  );
});

// Create a fresh blank form from the standard template.
router.post('/create', requireAdmin, (req, res) => {
  const pn = String(req.body?.part_number || '').trim();
  if (!pn) return res.status(400).json({ error: 'part_number required' });

  db.get(
    `SELECT id FROM cirris_forms WHERE part_number = ? ORDER BY id DESC LIMIT 1`,
    [pn],
    (checkErr, existing) => {
      if (checkErr) return res.status(500).json({ error: checkErr.message });
      if (existing) return res.status(409).json({ error: 'Cirris form already exists for this harness' });

      let buffer;
      try {
        buffer = getBlankTemplateBuffer();
      } catch (e) {
        console.error('[CIRRIS FORM] blank template read failed:', e);
        return res.status(500).json({ error: 'Blank Cirris template is unavailable' });
      }

      const filename = `${safeFilenamePart(pn)} Cirris Setup.xlsx`;
      db.run(
        `INSERT INTO cirris_forms
          (part_number, filename, file_data, file_size, uploaded_by, uploaded_at, source)
         VALUES (?, ?, ?, ?, ?, datetime('now','localtime'), 'blank')`,
        [pn, filename, buffer, buffer.length, req.user],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ ok: true, id: this.lastID, filename });
        }
      );
    }
  );
});

// Upload a completed/edited workbook. A new row is inserted so older versions remain recoverable.
// Body: { part_number, filename, file_data (base64) }
router.post('/', requireAdmin, (req, res) => {
  const { part_number, filename, file_data } = req.body || {};
  const pn = String(part_number || '').trim();
  const fn = String(filename || '').trim();

  if (!pn || !fn || !file_data) {
    return res.status(400).json({ error: 'Missing part_number, filename, or file_data' });
  }
  if (!fn.toLowerCase().endsWith('.xlsx')) {
    return res.status(400).json({ error: 'Cirris setup form must be an .xlsx file' });
  }

  let buffer;
  try {
    buffer = Buffer.from(String(file_data), 'base64');
  } catch {
    return res.status(400).json({ error: 'Invalid base64 file_data' });
  }
  if (!buffer.length) return res.status(400).json({ error: 'Empty file' });

  db.run(
    `INSERT INTO cirris_forms
      (part_number, filename, file_data, file_size, uploaded_by, uploaded_at, source)
     VALUES (?, ?, ?, ?, ?, datetime('now','localtime'), 'upload')`,
    [pn, fn, buffer, buffer.length, req.user],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

// Download the exact stored workbook.
router.get('/:id/download', (req, res) => {
  db.get(
    `SELECT id, filename, file_data FROM cirris_forms WHERE id = ?`,
    [req.params.id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Cirris form not found' });

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', `attachment; filename="${String(row.filename).replace(/"/g, '')}"`);
      res.send(row.file_data);
    }
  );
});

module.exports = router;
