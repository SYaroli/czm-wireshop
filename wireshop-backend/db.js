// db.js  (complete file)
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.resolve(__dirname, 'wireshop.db'), (err) => {
  if (err) console.error('Failed to connect to database:', err);
  else console.log('Connected to SQLite database');
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
    pauseTotal INTEGER DEFAULT 0
  )`);

  // Ensure missing columns on old DBs
  db.all(`PRAGMA table_info(jobs)`, (err, rows) => {
    if (err) return console.error('Error checking table info (jobs):', err);
    const names = (rows || []).map(c => c.name);
    if (!names.includes('pauseStart')) db.run(`ALTER TABLE jobs ADD COLUMN pauseStart INTEGER DEFAULT NULL`);
    if (!names.includes('pauseTotal')) db.run(`ALTER TABLE jobs ADD COLUMN pauseTotal INTEGER DEFAULT 0`);
  });

  // ARCHIVE (append-only, with soft delete)
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

  db.all(`PRAGMA table_info(jobs_archive)`, (err, rows) => {
    if (err) return console.error('Error checking table info (jobs_archive):', err);
    const names = (rows || []).map(c => c.name);
    const add = (col, def) => db.run(`ALTER TABLE jobs_archive ADD COLUMN ${col} ${def}`);
    if (!names.includes('isDeleted'))    add('isDeleted',    'INTEGER DEFAULT 0');
    if (!names.includes('deletedAt'))    add('deletedAt',    'INTEGER');
    if (!names.includes('deletedBy'))    add('deletedBy',    'TEXT');
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

  // USERS (case-insensitive unique usernames)
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pin TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','assembler'))
  )`);
});

module.exports = db;
