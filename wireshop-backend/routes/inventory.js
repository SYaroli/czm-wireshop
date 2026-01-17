const express = require('express');
const router = express.Router();
const db = require('../db');

let ADMIN_USERS = (process.env.ADMIN_USERS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

['shane','shane.yaroli','tyler','tyler.ellis','Tyler.Ellis'.toLowerCase()].forEach(u => {
  if (!ADMIN_USERS.includes(u.toLowerCase())) ADMIN_USERS.push(u.toLowerCase());
});

function getUser(req) {
  return (req.header('x-user') || '').trim().toLowerCase();
}
function requireUser(req,res,next){
  const u = getUser(req);
  if(!u) return res.status(401).json({error:'x-user required'});
  req.user = u;
  next();
}
function requireAdmin(req,res,next){
  const u = getUser(req);
  if(!u) return res.status(401).json({error:'x-user required'});
  if(!ADMIN_USERS.includes(u)) return res.status(403).json({error:'admin only'});
  req.user = u;
  next();
}

db.run(`CREATE TABLE IF NOT EXISTS inventory (
  partNumber TEXT PRIMARY KEY,
  description TEXT,
  location TEXT,
  qty INTEGER DEFAULT 0,
  minQty INTEGER DEFAULT 0,
  notes TEXT,
  updatedAt INTEGER,
  updatedBy TEXT
)`);

// persistent log table for inventory history
db.run(`CREATE TABLE IF NOT EXISTS inventory_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partNumber TEXT NOT NULL,
  ts INTEGER NOT NULL,
  user TEXT,
  delta INTEGER,
  qtyBefore INTEGER,
  qtyAfter INTEGER,
  note TEXT
)`);

router.get('/inventory-all', requireUser, (req,res)=>{
  db.all(
    `SELECT partNumber,description,location,qty,minQty,notes,updatedAt,updatedBy
     FROM inventory
     ORDER BY partNumber`,
    [],
    (err,rows)=>{
      if(err) return res.status(500).json({error:'db error'});
      res.json(rows||[]);
    }
  );
});

router.get('/inventory/:partNumber', requireUser, (req,res)=>{
  db.get(
    `SELECT partNumber,description,location,qty,minQty,notes,updatedAt,updatedBy
     FROM inventory
     WHERE partNumber = ?`,
    [req.params.partNumber],
    (err,row)=>{
      if(err) return res.status(500).json({error:'db error'});
      if(!row) return res.status(404).json({error:'not found'});
      res.json(row);
    }
  );
});

router.post('/inventory', requireAdmin, (req,res)=>{
  const {partNumber,description='',location='',qty=0,minQty=0,notes=''} = req.body||{};
  if(!partNumber) return res.status(400).json({error:'partNumber required'});
  const now = Date.now();
  db.run(
    `INSERT INTO inventory (partNumber,description,location,qty,minQty,notes,updatedAt,updatedBy)
     VALUES (?,?,?,?,?,?,?,?)`,
    [partNumber,description,location,qty,minQty,notes,now,req.user],
    function(err){
      if(err){
        if(String(err.message).includes('UNIQUE')) return res.status(409).json({error:'exists'});
        return res.status(500).json({error:'db error'});
      }
      res.json({ok:true});
    }
  );
});

router.put('/inventory/:partNumber', requireAdmin, (req,res)=>{
  const {description='',location='',qty=0,minQty=0,notes=''} = req.body||{};
  const now = Date.now();
  db.run(
    `UPDATE inventory
       SET description=?,
           location=?,
           qty=?,
           minQty=?,
           notes=?,
           updatedAt=?,
           updatedBy=?
     WHERE partNumber=?`,
    [description,location,qty,minQty,notes,now,req.user,req.params.partNumber],
    function(err){
      if(err) return res.status(500).json({error:'db error'});
      if(this.changes===0) return res.status(404).json({error:'not found'});
      res.json({ok:true});
    }
  );
});

/**
 * Set absolute qty (used by multiple pages).
 * IMPORTANT: This now ALSO writes a persistent inventory_log entry so "Recent Activity"
 * stays correct no matter which frontend path updated the qty.
 */
router.post('/inventory/:partNumber/qty', requireUser, (req,res)=>{
  const { qty, note = '' } = req.body||{};
  if(qty === undefined) return res.status(400).json({error:'qty required'});

  const partNumber = req.params.partNumber;
  const newQty = Number.isFinite(Number(qty)) ? Number(qty) : 0;
  const ts = Date.now();

  db.serialize(() => {
    db.get(
      `SELECT qty FROM inventory WHERE partNumber = ?`,
      [partNumber],
      (err, row) => {
        if (err) return res.status(500).json({ error: 'db error' });
        if (!row) return res.status(404).json({ error: 'not found' });

        const before = Number(row.qty) || 0;
        const after = newQty;
        const delta = after - before;

        db.run(
          `UPDATE inventory
             SET qty=?,
                 updatedAt=?,
                 updatedBy=?
           WHERE partNumber=?`,
          [after, ts, req.user, partNumber],
          function(updateErr){
            if(updateErr) return res.status(500).json({error:'db error'});
            if(this.changes===0) return res.status(404).json({error:'not found'});

            // Only log if something actually changed OR a note was provided
            const shouldLog = delta !== 0 || (String(note || '').trim().length > 0);

            if (!shouldLog) {
              return res.json({ ok: true, before, after, delta });
            }

            db.run(
              `INSERT INTO inventory_log (partNumber, ts, user, delta, qtyBefore, qtyAfter, note)
               VALUES (?,?,?,?,?,?,?)`,
              [
                partNumber,
                ts,
                req.user,
                Number(delta) || 0,
                Number(before) || 0,
                Number(after) || 0,
                String(note || '')
              ],
              function(logErr){
                if(logErr) return res.status(500).json({error:'db error'});
                res.json({ ok: true, before, after, delta, logId: this.lastID });
              }
            );
          }
        );
      }
    );
  });
});

router.delete('/inventory/:partNumber', requireAdmin, (req,res)=>{
  db.run(
    `DELETE FROM inventory WHERE partNumber=?`,
    [req.params.partNumber],
    function(err){
      if(err) return res.status(500).json({error:'db error'});
      if(this.changes===0) return res.status(404).json({error:'not found'});
      res.json({ok:true});
    }
  );
});

// read log entries for a part (used by inventory.html "Recent Activity")
// UPDATED: now returns `id` so admin can edit/delete specific entries
router.get('/inventory/:partNumber/log', requireUser, (req,res)=>{
  db.all(
    `SELECT id,
            partNumber,
            ts       AS "when",
            user,
            delta,
            qtyBefore AS "before",
            qtyAfter  AS "after",
            note
     FROM inventory_log
     WHERE partNumber = ?
     ORDER BY ts DESC
     LIMIT 200`,
    [req.params.partNumber],
    (err, rows)=>{
      if (err) return res.status(500).json({ error: 'db error' });
      res.json(rows || []);
    }
  );
});

// admin-only: delete a log row
router.delete('/inventory-log/:id', requireAdmin, (req,res)=>{
  const id = Number(req.params.id);
  if(!Number.isFinite(id)) return res.status(400).json({error:'invalid id'});

  db.run(
    `DELETE FROM inventory_log WHERE id = ?`,
    [id],
    function(err){
      if(err) return res.status(500).json({error:'db error'});
      if(this.changes === 0) return res.status(404).json({error:'not found'});
      res.json({ok:true});
    }
  );
});

// admin-only: edit log note only (keep history mostly honest)
router.put('/inventory-log/:id', requireAdmin, (req,res)=>{
  const id = Number(req.params.id);
  if(!Number.isFinite(id)) return res.status(400).json({error:'invalid id'});

  const { note = '' } = req.body || {};

  db.run(
    `UPDATE inventory_log
        SET note = ?
      WHERE id = ?`,
    [String(note || ''), id],
    function(err){
      if(err) return res.status(500).json({error:'db error'});
      if(this.changes === 0) return res.status(404).json({error:'not found'});
      res.json({ok:true});
    }
  );
});

// optional: manual log write (kept for compatibility)
router.post('/inventory/:partNumber/log', requireUser, (req,res)=>{
  const { delta = 0, before = 0, after = 0, note = '' } = req.body || {};
  const ts = Date.now();
  db.run(
    `INSERT INTO inventory_log (partNumber, ts, user, delta, qtyBefore, qtyAfter, note)
     VALUES (?,?,?,?,?,?,?)`,
    [
      req.params.partNumber,
      ts,
      req.user,
      Number(delta)||0,
      Number(before)||0,
      Number(after)||0,
      note
    ],
    function(err){
      if (err) return res.status(500).json({ error: 'db error' });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

module.exports = router;
