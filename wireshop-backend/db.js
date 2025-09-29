// db.js — open SQLite and apply migrations at boot
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = process.env.DB_FILE || '/data/wireshop.db';

// make sure the /data folder exists locally; on Render it's already there
try { fs.mkdirSync(path.dirname(DB_FILE), { recursive: true }); } catch {}

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function applyMigrations() {
  const dir = path.join(__dirname, 'migrations');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  } catch {
    console.log('[db] no migrations directory; skipping');
    return;
  }

  const hasColumn = (table, column) => {
    try {
      const rows = db.prepare(`PRAGMA table_info(${table});`).all();
      return rows.some(r => String(r.name).toLowerCase() === String(column).toLowerCase());
    } catch {
      return false;
    }
  };

  for (const file of files) {
    const full = path.join(dir, file);
    const sqlText = fs.readFileSync(full, 'utf8');

    // naive split on semicolons at line ends; fine for our simple files
    const statements = sqlText
      .split(/;\s*$/m)
      .map(s => s.trim())
      .filter(Boolean);

    db.transaction(() => {
      for (let stmt of statements) {
        // guard: if this migration tries to add notes but it already exists, skip it
        if (/ALTER\s+TABLE\s+inventory\s+ADD\s+COLUMN\s+notes/i.test(stmt)) {
          if (hasColumn('inventory', 'notes')) {
            console.log('[db] skip ADD COLUMN notes (already exists)');
            continue;
          }
        }
        db.prepare(stmt).run();
      }
    })();

    console.log(`[db] applied migration: ${file}`);
  }
}

applyMigrations();

module.exports = db;
