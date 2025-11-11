// import-catalog.js
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const { Database } = require("sqlite3").verbose();

// 1. load the frontend catalog.js (browser style: window.catalog = [...])
const catalogPath = path.join(__dirname, "../wireshop-frontend/catalog.js");
const catalogCode = fs.readFileSync(catalogPath, "utf8");

// 2. run it in a sandbox that has window
const sandbox = { window: {} };
vm.runInNewContext(catalogCode, sandbox);
const catalog = sandbox.window.catalog || [];

// 3. open db (adjust path if your db is somewhere else)
const db = new Database(path.join(__dirname, "wireshop.db"));

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
       description = COALESCE(excluded.description, inventory.description),
       location    = COALESCE(excluded.location,    inventory.location),
       notes       = COALESCE(excluded.notes,       inventory.notes)`
  );

  for (const item of catalog) {
    const pn = String(item.partNumber || "").trim();
    if (!pn) continue;

    stmt.run(
      pn,
      item.printName || "",
      item.location || "",
      0, // we don't get qty from catalog
      item.notes && item.notes !== "NaN" ? item.notes : ""
    );
  }

  stmt.finalize(() => {
    console.log("catalog imported.");
    db.close();
  });
});
