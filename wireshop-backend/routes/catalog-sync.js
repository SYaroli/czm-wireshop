const express = require("express");
const router = express.Router();
const db = require("../db");

function getUser(req) {
  return (req.header("x-user") || "").trim().toLowerCase();
}

let ADMIN_USERS = (process.env.ADMIN_USERS || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

["shane", "shane.yaroli", "tyler", "tyler.ellis"].forEach(u => {
  if (!ADMIN_USERS.includes(u)) ADMIN_USERS.push(u);
});

function requireAdmin(req, res, next) {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: "x-user required" });
  if (!ADMIN_USERS.includes(u)) return res.status(403).json({ error: "admin only" });
  req.user = u;
  next();
}

function ensureInventoryColumns(done) {
  db.all(`PRAGMA table_info(inventory)`, (err, rows) => {
    if (err) return done(err);

    const names = (rows || []).map(r => String(r.name || "").toLowerCase());
    const alters = [];

    if (!names.includes("description")) alters.push(`ALTER TABLE inventory ADD COLUMN description TEXT`);
    if (!names.includes("location")) alters.push(`ALTER TABLE inventory ADD COLUMN location TEXT`);
    if (!names.includes("minqty")) alters.push(`ALTER TABLE inventory ADD COLUMN minQty INTEGER DEFAULT 0`);
    if (!names.includes("notes")) alters.push(`ALTER TABLE inventory ADD COLUMN notes TEXT`);
    if (!names.includes("sanumber")) alters.push(`ALTER TABLE inventory ADD COLUMN saNumber TEXT`);
    if (!names.includes("expectedhours")) alters.push(`ALTER TABLE inventory ADD COLUMN expectedHours REAL`);

    if (!alters.length) return done();

    let i = 0;
    function nextAlter(alterErr) {
      if (alterErr) return done(alterErr);
      if (i >= alters.length) return done();
      const sql = alters[i++];
      db.run(sql, nextAlter);
    }
    nextAlter();
  });
}

router.post("/catalog-sync", requireAdmin, (req, res) => {
  const catalog = Array.isArray(req.body && req.body.catalog) ? req.body.catalog : null;
  if (!catalog) {
    return res.status(400).json({ error: "catalog array required" });
  }

  ensureInventoryColumns((ensureErr) => {
    if (ensureErr) {
      console.error("[catalog-sync] ensure columns failed:", ensureErr);
      return res.status(500).json({ error: "failed to prepare inventory columns" });
    }

    db.serialize(() => {
      let scanned = 0;
      let matched = 0;
      let updated = 0;
      let skipped = 0;
      let failed = 0;
      const changedParts = [];

      function finish() {
        return res.json({
          success: true,
          scanned,
          matched,
          updated,
          skipped,
          failed,
          changedParts
        });
      }

      function processNext(index) {
        if (index >= catalog.length) return finish();

        const item = catalog[index] || {};
        const partNumber = String(item.partNumber || "").trim();
        const printName = String(item.printName || "").trim();
        const saNumber = String(item.saNumber || "").trim();
        const notes = item.notes == null ? "" : String(item.notes).trim();
        const location = String(item.location || "").trim();
        const expectedHours =
          item.expectedHours === "" || item.expectedHours == null
            ? null
            : Number(item.expectedHours);

        scanned++;

        if (!partNumber) {
          skipped++;
          return processNext(index + 1);
        }

        db.get(
          `SELECT partNumber, description, location, saNumber, expectedHours, notes
             FROM inventory
            WHERE partNumber = ?`,
          [partNumber],
          (getErr, row) => {
            if (getErr) {
              failed++;
              console.error("[catalog-sync] select failed for", partNumber, getErr);
              return processNext(index + 1);
            }

            if (!row) {
              skipped++;
              return processNext(index + 1);
            }

            matched++;

            const currentDescription = String(row.description || "").trim();
            const currentLocation = String(row.location || "").trim();
            const currentSaNumber = String(row.saNumber || "").trim();
            const currentNotes = row.notes == null ? "" : String(row.notes).trim();
            const currentExpectedHours =
              row.expectedHours === "" || row.expectedHours == null
                ? null
                : Number(row.expectedHours);

            const nextDescription = currentDescription || printName;
            const nextLocation = currentLocation || location;
            const nextSaNumber = currentSaNumber || saNumber;
            const nextNotes = currentNotes || notes;
            const nextExpectedHours =
              currentExpectedHours == null || Number.isNaN(currentExpectedHours)
                ? (Number.isFinite(expectedHours) ? expectedHours : null)
                : currentExpectedHours;

            const changed =
              nextDescription !== currentDescription ||
              nextLocation !== currentLocation ||
              nextSaNumber !== currentSaNumber ||
              nextNotes !== currentNotes ||
              nextExpectedHours !== currentExpectedHours;

            if (!changed) {
              skipped++;
              return processNext(index + 1);
            }

            db.run(
              `UPDATE inventory
                  SET description = ?,
                      location = ?,
                      saNumber = ?,
                      expectedHours = ?,
                      notes = ?
                WHERE partNumber = ?`,
              [
                nextDescription || null,
                nextLocation || null,
                nextSaNumber || null,
                nextExpectedHours,
                nextNotes || null,
                partNumber
              ],
              function (updateErr) {
                if (updateErr) {
                  failed++;
                  console.error("[catalog-sync] update failed for", partNumber, updateErr);
                  return processNext(index + 1);
                }

                if (this.changes > 0) {
                  updated++;
                  changedParts.push(partNumber);
                } else {
                  skipped++;
                }

                processNext(index + 1);
              }
            );
          }
        );
      }

      processNext(0);
    });
  });
});

module.exports = router;
