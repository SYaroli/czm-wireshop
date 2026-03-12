const express = require("express");
const router = express.Router();
const db = require("../db");

// sync catalog metadata into inventory table
router.post("/catalog-sync", async (req, res) => {
  try {
    const catalog = req.body.catalog || [];

    if (!Array.isArray(catalog)) {
      return res.status(400).json({ error: "catalog array required" });
    }

    let updated = 0;

    for (const item of catalog) {
      const {
        partNumber,
        printName,
        saNumber,
        expectedHours,
        notes,
        location
      } = item;

      const row = await db.get(
        "SELECT partNumber, description, location FROM inventory WHERE partNumber = ?",
        [partNumber]
      );

      if (!row) continue;

      const descMissing = !row.description || row.description.trim() === "";
      const locMissing = !row.location || row.location.trim() === "";

      if (descMissing || locMissing) {
        await db.run(
          `UPDATE inventory
           SET description = COALESCE(description, ?),
               location = COALESCE(location, ?),
               saNumber = COALESCE(saNumber, ?),
               expectedHours = COALESCE(expectedHours, ?),
               notes = COALESCE(notes, ?)
           WHERE partNumber = ?`,
          [
            printName,
            location,
            saNumber,
            expectedHours,
            notes,
            partNumber
          ]
        );

        updated++;
      }
    }

    res.json({
      success: true,
      updated
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "catalog sync failed" });
  }
});

module.exports = router;