// db.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.resolve(__dirname, 'wireshop.db'), (err) => {
  if (err) console.error('Failed to connect to database:', err);
  else console.log('Connected to SQLite database');
});

db.serialize(() => {
  // LIVE table (current behavior)
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

  // Make sure legacy DBs have the two pause columns
  db.all(`PRAGMA table_info(jobs)`, (err, rows) => {
    if (err) return console.error('Error checking table info:', err);
    const names = (rows || []).map(c => c.name);
    if (!names.includes('pauseStart')) {
      db.run(`ALTER TABLE jobs ADD COLUMN pauseStart INTEGER DEFAULT NULL`);
    }
    if (!names.includes('pauseTotal')) {
      db.run(`ALTER TABLE jobs ADD COLUMN pauseTotal INTEGER DEFAULT 0`);
    }
  });

  // ARCHIVE table (immutable snapshots)
  db.run(`CREATE TABLE IF NOT EXISTS jobs_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sourceId INTEGER,            -- id from jobs when it finished
    username TEXT,
    partNumber TEXT,
    note TEXT,
    startTime INTEGER,
    endTime INTEGER,
    pauseTotal INTEGER DEFAULT 0,
    totalActive INTEGER DEFAULT 0,   -- (end - start - pauseTotal)
    finishedAt INTEGER DEFAULT (strftime('%s','now')*1000)
  )`);
});

module.exports = db;
