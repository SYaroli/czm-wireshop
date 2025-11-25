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

// MAIN HARNESS INVENTORY
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

// HARNESS INVENTORY LOGS
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

// 🧰 SHOP BENCHSTOCK (NEW)
db.run(`CREATE TABLE IF NOT EXISTS benchstock (
  partNumber TEXT PRIMARY KEY,
  description TEXT,
  qty INTEGER DEFAULT 0,
  notes TEXT,
  location TEXT,
  updatedAt INTEGER,
  updatedBy TEXT
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

router.post('/inventory/:partNumber/qty', requireUser, (req,res)=>{
  const {qty} = req.body||{};
  if(qty===undefined) return res.status(400).json({error:'qty required'});
  const now = Date.now();
  db.run(
    `UPDATE inventory
       SET qty=?,
           updatedAt=?,
           updatedBy=?
     WHERE partNumber=?`,
    [Number(qty)||0,now,req.user,req.params.partNumber],
    function(err){
      if(err) return res.status(500).json({error:'db error'});
      if(this.changes===0) return res.status(404).json({error:'not found'});
      res.json({ok:true});
    }
  );
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

// INVENTORY LOG ROUTES
router.get('/inventory/:partNumber/log', requireUser, (req,res)=>{
  db.all(
    `SELECT partNumber,
            ts       AS "when",
            user,
            delta,
            qtyBefore AS "before",
            qtyAfter  AS "after",
            note
     FROM inventory_log
     WHERE partNumber = ?
     ORDER BY ts DESC
     LIMIT 100`,
    [req.params.partNumber],
    (err, rows)=>{
      if (err) return res.status(500).json({ error: 'db error' });
      res.json(rows || []);
    }
  );
});

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

/* =============== SHOP BENCHSTOCK API (NEW) =============== */

// list all benchstock
router.get('/benchstock-all', requireUser, (req,res)=>{
  db.all(
    `SELECT partNumber, description, qty, notes, location, updatedAt, updatedBy
       FROM benchstock
      ORDER BY partNumber`,
    [],
    (err,rows)=>{
      if (err) return res.status(500).json({ error: 'db error' });
      res.json(rows || []);
    }
  );
});

// create benchstock item
router.post('/benchstock', requireAdmin, (req,res)=>{
  const { partNumber, description = '', qty = 0, notes = '', location = '' } = req.body || {};
  if (!partNumber) return res.status(400).json({ error: 'partNumber required' });
  const now = Date.now();
  db.run(
    `INSERT INTO benchstock (partNumber, description, qty, notes, location, updatedAt, updatedBy)
     VALUES (?,?,?,?,?,?,?)`,
    [partNumber, description, Number(qty)||0, notes, location, now, req.user],
    function(err){
      if (err) {
        if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'exists' });
        return res.status(500).json({ error: 'db error' });
      }
      res.json({ ok: true });
    }
  );
});

// update benchstock item
router.put('/benchstock/:partNumber', requireAdmin, (req,res)=>{
  const { description = '', qty = 0, notes = '', location = '' } = req.body || {};
  const now = Date.now();
  db.run(
    `UPDATE benchstock
        SET description=?,
            qty=?,
            notes=?,
            location=?,
            updatedAt=?,
            updatedBy=?
      WHERE partNumber=?`,
    [description, Number(qty)||0, notes, location, now, req.user, req.params.partNumber],
    function(err){
      if (err) return res.status(500).json({ error: 'db error' });
      if (this.changes === 0) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true });
    }
  );
});

// delete benchstock item
router.delete('/benchstock/:partNumber', requireAdmin, (req,res)=>{
  db.run(
    `DELETE FROM benchstock WHERE partNumber=?`,
    [req.params.partNumber],
    function(err){
      if (err) return res.status(500).json({ error: 'db error' });
      if (this.changes === 0) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true });
    }
  );
});

module.exports = router;
