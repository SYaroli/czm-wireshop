// db.js — SQLite schema + migrations (persistent on Render)
// Uses DB_PATH (e.g. /data/wireshop.db) if provided; falls back to bundled file.

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// Prefer a persistent disk path when provided (Render Disk mounted at /data)
const dbPath = process.env.DB_PATH || path.join(__dirname, 'wireshop.db');

// Seed the persistent DB once if it's missing but a bundled db exists.
// This preserves your current data the first time you switch to /data.
try {
  if (process.env.DB_PATH && !fs.existsSync(dbPath)) {
    const bundled = path.join(__dirname, 'wireshop.db');
    if (fs.existsSync(bundled)) {
      fs.copyFileSync(bundled, dbPath);
      console.log('[db] Seeded persistent DB from bundled file ->', dbPath);
    } else {
      console.log('[db] No bundled DB found to seed, starting fresh at', dbPath);
    }
  }
} catch (e) {
  console.warn('[db] Seed check failed:', e?.message || e);
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('Failed to connect to database:', err);
  else console.log('Connected to SQLite database at', dbPath);
});

db.serialize(() => {
  // LIVE jobs
  db.run(`CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    partNumber TEXT,
    action TEXT,
    note TEXT,
    startTime INTEGER,
    endTime INTEGER,
    pauseStart INTEGER DEFAULT NULL,
    pauseTotal INTEGER DEFAULT 0,
    autoPaused INTEGER DEFAULT 0 -- 0=none, 1=auto break/lunch, 2=auto dayend (sticky)
  )`);
  db.all(`PRAGMA table_info(jobs)`, (err, rows = []) => {
    if (err) return console.error('PRAGMA jobs:', err);
    const names = rows.map(c => c.name);
    if (!names.includes('pauseStart')) db.run(`ALTER TABLE jobs ADD COLUMN pauseStart INTEGER DEFAULT NULL`);
    if (!names.includes('pauseTotal')) db.run(`ALTER TABLE jobs ADD COLUMN pauseTotal INTEGER DEFAULT 0`);
    if (!names.includes('autoPaused')) db.run(`ALTER TABLE jobs ADD COLUMN autoPaused INTEGER DEFAULT 0`);
  });

  // ARCHIVE (append-only, soft delete)
  db.run(`CREATE TABLE IF NOT EXISTS jobs_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sourceId INTEGER,
    username TEXT,
    partNumber TEXT,
    note TEXT,
    startTime INTEGER,
    endTime INTEGER,
    pauseTotal INTEGER DEFAULT 0,
    totalActive INTEGER DEFAULT 0,
    finishedAt INTEGER DEFAULT (strftime('%s','now')*1000),
    isDeleted INTEGER DEFAULT 0,
    deletedAt INTEGER,
    deletedBy TEXT,
    deleteReason TEXT
  )`);
  db.all(`PRAGMA table_info(jobs_archive)`, (err, rows = []) => {
    if (err) return console.error('PRAGMA jobs_archive:', err);
    const names = rows.map(c => c.name);
    const add = (c, d) => db.run(`ALTER TABLE jobs_archive ADD COLUMN ${c} ${d}`);
    if (!names.includes('isDeleted')) add('isDeleted', 'INTEGER DEFAULT 0');
    if (!names.includes('deletedAt')) add('deletedAt', 'INTEGER');
    if (!names.includes('deletedBy')) add('deletedBy', 'TEXT');
    if (!names.includes('deleteReason')) add('deleteReason', 'TEXT');
  });

  // ADJUSTMENTS ledger
  db.run(`CREATE TABLE IF NOT EXISTS jobs_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    archiveId INTEGER NOT NULL,
    overrideStartTime INTEGER,
    overrideEndTime INTEGER,
    overridePauseTotal INTEGER,
    overridePartNumber TEXT,
    overrideNote TEXT,
    overrideUsername TEXT,
    reason TEXT NOT NULL,
    adminUser TEXT,
    createdAt INTEGER DEFAULT (strftime('%s','now')*1000)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_adj_archive ON jobs_adjustments(archiveId, id)`);

  // USERS
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pin TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','assembler'))
  )`);

  // ===== INVENTORY (snapshot + ledger) =====
  db.run(`CREATE TABLE IF NOT EXISTS inventory (
    partNumber TEXT PRIMARY KEY,
    qty INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER,
    updatedBy TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS inventory_txns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partNumber TEXT NOT NULL,
    delta INTEGER NOT NULL,
    qtyBefore INTEGER NOT NULL,
    qtyAfter INTEGER NOT NULL,
    note TEXT,
    user TEXT,
    ts INTEGER DEFAULT (strftime('%s','now')*1000)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_inv_txn_part_ts ON inventory_txns(partNumber, ts DESC)`);
});

module.exports = db;
