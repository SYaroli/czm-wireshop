// db.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Database will live in root of project
const db = new sqlite3.Database(path.resolve(__dirname, 'wireshop.db'), (err) => {
  if (err) console.error('Failed to connect to database:', err);
  else console.log('Connected to SQLite database');
});

// Create jobs table if it doesn’t exist
db.serialize(() => {
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

  // Check and add columns if missing
  db.all(`PRAGMA table_info(jobs)`, (err, rows) => {
    if (err) {
      console.error('Error checking table info:', err);
      return;
    }
    if (!rows || rows.length === 0) {
      console.log('No columns found, table might not be initialized yet. Recreating...');
      db.run(`DROP TABLE IF EXISTS jobs`);
      db.run(`CREATE TABLE jobs (
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
      return;
    }
    const columnNames = rows.map(c => c.name);
    if (!columnNames.includes('pauseStart')) {
      db.run(`ALTER TABLE jobs ADD COLUMN pauseStart INTEGER DEFAULT NULL`, (err) => {
        if (err) console.error('Error adding pauseStart column:', err);
        else console.log('Added pauseStart column');
      });
    }
    if (!columnNames.includes('pauseTotal')) {
      db.run(`ALTER TABLE jobs ADD COLUMN pauseTotal INTEGER DEFAULT 0`, (err) => {
        if (err) console.error('Error adding pauseTotal column:', err);
        else console.log('Added pauseTotal column');
      });
    }
  });
});

module.exports = db;