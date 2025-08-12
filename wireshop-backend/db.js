// db.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.resolve(__dirname, 'wireshop.db'), (err) => {
  if (err) console.error('Failed to connect to database:', err);
  else console.log('Connected to SQLite database');
});

db.serialize(() => {
  // LIVE
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

  // Ensure pause columns on legacy DBs
  db.all(`PRAGMA table_info(jobs)`, (err, rows) => {
    if (err) return console.error('Error checking table info:', err);
    const names = (rows || []).map(c => c.name);
    if (!names.includes('pauseStart')) db.run(`ALTER TABLE jobs ADD COLUMN pauseStart INTEGER DEFAULT NULL`);
    if (!names.includes('pauseTotal')) db.run(`ALTER TABLE jobs ADD COLUMN pauseTotal INTEGER DEFAULT 0`);
  });

  // ARCHIVE snapshots (immutable base)
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
    finishedAt INTEGER DEFAULT (strftime('%s','now')*1000)
  )`);

  // ADJUSTMENTS ledger (layered overrides, never delete base)
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
});

module.exports = db;
