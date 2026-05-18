// routes/komax-files.js
// Upload, download, and audit Komax Excel job files.
// Files stored as BLOBs in SQLite so no external storage needed.

const express = require('express');
const router = express.Router();
const db = require('../db');

const ADMIN_USERS = (process.env.ADMIN_USERS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const currentUser = req => (req.header('x-user') || 'unknown').toLowerCase();
const requireAdmin = (req, res, next) =>
  ADMIN_USERS.includes(currentUser(req))
    ? next()
    : res.status(403).json({ error: 'Admin only' });

// ── LIST all files (metadata only, no blobs) ──────────────────────────────────
// Returns most-recent upload per part_number by default.
// ?all=1 returns every upload (for the admin audit view).
router.get('/', (req, res) => {
  const showAll = req.query.all === '1';
  const sql = showAll
    ? `SELECT id, part_number, filename, file_size, uploaded_by, uploaded_at
         FROM komax_files
        ORDER BY part_number ASC, uploaded_at DESC`
    : `SELECT id, part_number, filename, file_size, uploaded_by, uploaded_at
         FROM komax_files
        WHERE id IN (
          SELECT MAX(id) FROM komax_files GROUP BY part_number
        )
        ORDER BY part_number ASC`;

  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ── CHECK if a file exists for a part number (lightweight, no blob) ──────────
router.get('/check', (req, res) => {
  const pn = (req.query.part_number || '').trim();
  if (!pn) return res.json({ exists: false });

  db.get(
    `SELECT id, part_number, filename, file_size, uploaded_by, uploaded_at
       FROM komax_files WHERE part_number = ? ORDER BY id DESC LIMIT 1`,
    [pn],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(row ? { exists: true, file: row } : { exists: false });
    }
  );
});

// ── UPLOAD (admin only) ───────────────────────────────────────────────────────
// Body: { part_number, filename, file_data (base64) }
// Inserts a new row — keeps history, doesn't overwrite.
router.post('/', requireAdmin, (req, res) => {
  const { part_number, filename, file_data } = req.body || {};
  if (!part_number || !filename || !file_data) {
    return res.status(400).json({ error: 'Missing part_number, filename, or file_data' });
  }

  let buffer;
  try {
    buffer = Buffer.from(file_data, 'base64');
  } catch (e) {
    return res.status(400).json({ error: 'Invalid base64 file_data' });
  }

  const user = currentUser(req);
  db.run(
    `INSERT INTO komax_files (part_number, filename, file_data, file_size, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))`,
    [part_number.trim(), filename.trim(), buffer, buffer.length, user],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

// ── DOWNLOAD — logs who pulled it and when ────────────────────────────────────
router.get('/:id/download', (req, res) => {
  const user = currentUser(req);
  db.get(
    `SELECT id, part_number, filename, file_data FROM komax_files WHERE id = ?`,
    [req.params.id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'File not found' });

      // log it (fire-and-forget — don't delay the download)
      db.run(
        `INSERT INTO komax_downloads (file_id, downloaded_by, downloaded_at)
         VALUES (?, ?, datetime('now','localtime'))`,
        [row.id, user]
      );

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
      res.send(row.file_data);
    }
  );
});

// ── UPDATE — replace file_data in place (admin only) ─────────────────────────
// Body: { file_data (base64), filename? }
router.put('/:id', requireAdmin, (req, res) => {
  const { file_data, filename } = req.body || {};
  if (!file_data) return res.status(400).json({ error: 'Missing file_data' });

  let buffer;
  try { buffer = Buffer.from(file_data, 'base64'); }
  catch (e) { return res.status(400).json({ error: 'Invalid base64 file_data' }); }

  const user = currentUser(req);
  const sql = filename
    ? `UPDATE komax_files SET file_data=?, file_size=?, filename=?, uploaded_by=?, uploaded_at=datetime('now','localtime') WHERE id=?`
    : `UPDATE komax_files SET file_data=?, file_size=?, uploaded_by=?, uploaded_at=datetime('now','localtime') WHERE id=?`;
  const params = filename
    ? [buffer, buffer.length, filename, user, req.params.id]
    : [buffer, buffer.length, user, req.params.id];

  db.run(sql, params, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'File not found' });
    res.json({ ok: true });
  });
});

// ── DELETE (admin only) ───────────────────────────────────────────────────────
router.delete('/:id', requireAdmin, (req, res) => {
  db.run(`DELETE FROM komax_files WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'File not found' });
    res.json({ ok: true });
  });
});

// ── DOWNLOAD LOG for a specific file (admin only) ─────────────────────────────
router.get('/:id/log', requireAdmin, (req, res) => {
  db.all(
    `SELECT downloaded_by, downloaded_at
       FROM komax_downloads WHERE file_id = ?
      ORDER BY downloaded_at DESC`,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

module.exports = router;
