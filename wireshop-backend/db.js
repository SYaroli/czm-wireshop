// db.js
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

sqlite3.verbose();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, 'wireshop.db');

export function getDB() {
  return new sqlite3.Database(DB_PATH);
}

// Create tables if not exist, including secure users table
export function initDB() {
  const db = getDB();
  db.serialize(() => {
    // Jobs table(s) assumed to already exist in your app.
    // Add/keep whatever you already have.

    // Users table
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        pin_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','assembler')),
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      )
    `);
    // Simple index
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)`);
  });
  db.close();
}
