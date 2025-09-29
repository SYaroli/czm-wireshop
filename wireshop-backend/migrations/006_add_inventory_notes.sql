PRAGMA foreign_keys=ON;

-- History table for note edits
CREATE TABLE IF NOT EXISTS inventory_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partNumber TEXT NOT NULL,
  note TEXT NOT NULL,
  updatedBy TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_notes_part_ts
  ON inventory_notes(partNumber, ts DESC);

-- Add a notes column to inventory for the current note
-- If your inventory table ALREADY has a `notes` column, delete this line.
ALTER TABLE inventory ADD COLUMN notes TEXT;
