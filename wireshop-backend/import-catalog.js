// import-catalog.js
const path = require("path");
const { Database } = require("sqlite3").verbose();

// adjust if your db file is elsewhere
const db = new Database(path.join(__dirname, "wireshop.db"));

const catalog = require("../wireshop-frontend/catalog.js").catalog || [];

db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS inventory (
      partNumber TEXT PRIMARY KEY,
      description TEXT,
      location TEXT,
      qty INTEGER DEFAULT 0,
      notes TEXT
    )`
  );

  const stmt = db.prepare(
    `INSERT INTO inventory (partNumber, description, location, qty, notes)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(partNumber) DO UPDATE SET
       description=COALESCE(excluded.description, inventory.description),
       location=COALESCE(excluded.location, inventory.location),
       notes=COALESCE(excluded.notes, inventory.notes)`
  );

  for (const item of catalog) {
    const pn = String(item.partNumber || "").trim();
    if (!pn) continue;
    stmt.run(
      pn,
      item.printName || "",
      item.location || "",
      0,
      (item.notes && item.notes !== "NaN") ? item.notes : ""
    );
  }

  stmt.finalize(() => {
    console.log("catalog imported.");
    db.close();
  });
});
