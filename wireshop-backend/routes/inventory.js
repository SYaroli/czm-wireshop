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

router.get('/inventory-all', requireUser, (req,res)=>{
  db.all(`SELECT partNumber,description,location,qty,minQty,notes,updatedAt,updatedBy FROM inventory ORDER BY partNumber`, [], (err,rows)=>{
    if(err) return res.status(500).json({error:'db error'});
    res.json(rows||[]);
  });
});

router.get('/inventory/:partNumber', requireUser, (req,res)=>{
  db.get(`SELECT partNumber,description,location,qty,minQty,notes,updatedAt,updatedBy FROM inventory WHERE partNumber = ?`,
    [req.params.partNumber],
    (err,row)=>{
      if(err) return res.status(500).json({error:'db error'});
      if(!row) return res.status(404).json({error:'not found'});
      res.json(row);
    });
});

router.post('/inventory/:partNumber/qty', requireUser, (req, res) => {
  const { qty, note = '' } = req.body || {};
  if (qty === undefined) return res.status(400).json({ error: 'qty required' });

  const partNumber = req.params.partNumber;
  const now = Date.now();

  // get current qty first
  db.get(`SELECT qty FROM inventory WHERE partNumber = ?`, [partNumber], (err, row) => {
    if (err) return res.status(500).json({ error: 'db error' });
    if (!row) return res.status(404).json({ error: 'not found' });

    const before = Number(row.qty) || 0;
    const after  = Number(qty) || 0;
    const delta  = after - before;

    db.run(
      `UPDATE inventory SET qty = ?, updatedAt = ?, updatedBy = ? WHERE partNumber = ?`,
      [after, now, req.user, partNumber],
      function (err2) {
        if (err2) return res.status(500).json({ error: 'db error' });
        if (this.changes === 0) return res.status(404).json({ error: 'not found' });

        db.run(
          `INSERT INTO inventory_txns (partNumber, delta, qtyBefore, qtyAfter, note, user, ts)
           VALUES (?,?,?,?,?,?,?)`,
          [partNumber, delta, before, after, note, req.user, now],
          (err3) => {
            if (err3) console.error('inventory_txns insert failed', err3);
            res.json({ ok: true, qty: after, updatedAt: now, updatedBy: req.user });
          }
        );
      }
    );
  });
});
router.put('/inventory/:partNumber', requireAdmin, (req,res)=>{
  const {description='',location='',qty=0,minQty=0,notes=''} = req.body||{};
  const now = Date.now();
  db.run(
    `UPDATE inventory SET description=?,location=?,qty=?,minQty=?,notes=?,updatedAt=?,updatedBy=? WHERE partNumber=?`,
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
    `UPDATE inventory SET qty=?,updatedAt=?,updatedBy=? WHERE partNumber=?`,
    [Number(qty)||0,now,req.user,req.params.partNumber],
    function(err){
      if(err) return res.status(500).json({error:'db error'});
      if(this.changes===0) return res.status(404).json({error:'not found'});
      res.json({ok:true});
    }
  );
});

router.delete('/inventory/:partNumber', requireAdmin, (req,res)=>{
  db.run(`DELETE FROM inventory WHERE partNumber=?`, [req.params.partNumber], function(err){
    if(err) return res.status(500).json({error:'db error'});
    if(this.changes===0) return res.status(404).json({error:'not found'});
    res.json({ok:true});
  });
});

module.exports = router;

