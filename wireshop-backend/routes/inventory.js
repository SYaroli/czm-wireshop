const express = require('express');
const router = express.Router();
const db = require('../db');

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
  db.get(
    `SELECT role FROM users WHERE username = ? COLLATE NOCASE`,
    [u],
    (err, row) => {
      if(err) return res.status(500).json({error:'db error'});
      if(!row || String(row.role||'').toLowerCase() !== 'admin')
        return res.status(403).json({error:'admin only'});
      req.user = u;
      next();
    }
  );
}

db.run(`CREATE TABLE IF NOT EXISTS inventory (
  partNumber TEXT PRIMARY KEY,
  description TEXT,
  location TEXT,
  qty INTEGER DEFAULT 0,
  minQty INTEGER DEFAULT 0,
  buildValueHours REAL NOT NULL DEFAULT 0,
  notes TEXT,
  updatedAt INTEGER,
  updatedBy TEXT
)`);

function ensureBuildValueColumn(done){
  db.all(`PRAGMA table_info(inventory)`, (err, rows = []) => {
    if(err) return done(err);
    const names = rows.map(c => String(c.name || '').toLowerCase());
    if(names.includes('buildvaluehours')) return done();
    db.run(`ALTER TABLE inventory ADD COLUMN buildValueHours REAL NOT NULL DEFAULT 0`, done);
  });
}

ensureBuildValueColumn(err => {
  if(err) console.error('[db] buildValueHours migration failed:', err);
});

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
  ensureBuildValueColumn((ensureErr) => {
    if(ensureErr) return res.status(500).json({error:'db error'});
    db.all(
      `SELECT partNumber,description,location,qty,minQty,
              COALESCE(buildValueHours,0) AS buildValueHours,
              notes,updatedAt,updatedBy
       FROM inventory
       ORDER BY partNumber`,
      [],
      (err,rows)=>{
        if(err) return res.status(500).json({error:'db error'});
        res.json(rows||[]);
      }
    );
  });
});

router.get('/inventory/:partNumber', requireUser, (req,res)=>{
  ensureBuildValueColumn((ensureErr) => {
    if(ensureErr) return res.status(500).json({error:'db error'});
    db.get(
      `SELECT partNumber,description,location,qty,minQty,
              COALESCE(buildValueHours,0) AS buildValueHours,
              notes,updatedAt,updatedBy
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
});

router.put('/inventory/:partNumber/build-value', requireAdmin, (req,res)=>{
  ensureBuildValueColumn((ensureErr) => {
    if(ensureErr) return res.status(500).json({error:'db error'});

    const raw = req.body?.buildValueHours;
    const parsed = Number(raw);
    if(!Number.isFinite(parsed) || parsed < 0)
      return res.status(400).json({error:'buildValueHours must be zero or greater'});

    const value = Math.round(parsed * 100) / 100;
    const now = Date.now();
    db.run(
      `UPDATE inventory
          SET buildValueHours = ?, updatedAt = ?, updatedBy = ?
        WHERE partNumber = ?`,
      [value, now, req.user, req.params.partNumber],
      function(err){
        if(err) return res.status(500).json({error:'db error'});
        if(this.changes===0) return res.status(404).json({error:'not found'});
        res.json({ok:true,partNumber:req.params.partNumber,buildValueHours:value});
      }
    );
  });
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
       SET description=?, location=?, qty=?, minQty=?, notes=?, updatedAt=?, updatedBy=?
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
  const { qty, note = '' } = req.body||{};
  if(qty === undefined) return res.status(400).json({error:'qty required'});
  const partNumber = req.params.partNumber;
  const parsedQty = Number(qty);
  if (!Number.isFinite(parsedQty)) return res.status(400).json({ error:'invalid qty' });
  const newQty = Math.trunc(parsedQty);
  const ts = Date.now();

  db.serialize(() => {
    db.get(`SELECT qty FROM inventory WHERE partNumber = ?`, [partNumber], (err, row) => {
      if (err) return res.status(500).json({ error: 'db error' });
      if (!row) return res.status(404).json({ error: 'not found' });
      const before = Number(row.qty) || 0;
      const after = newQty;
      const delta = after - before;
      if (after < 0) return res.status(400).json({error:'insufficient stock',before,requestedQty:after});

      db.run(
        `UPDATE inventory SET qty=?, updatedAt=?, updatedBy=? WHERE partNumber=?`,
        [after, ts, req.user, partNumber],
        function(updateErr){
          if(updateErr) return res.status(500).json({error:'db error'});
          if(this.changes===0) return res.status(404).json({error:'not found'});
          const shouldLog = delta !== 0 || String(note || '').trim().length > 0;
          if (!shouldLog) return res.json({ ok: true, before, after, delta });
          db.run(
            `INSERT INTO inventory_log (partNumber, ts, user, delta, qtyBefore, qtyAfter, note) VALUES (?,?,?,?,?,?,?)`,
            [partNumber, ts, req.user, Number(delta)||0, Number(before)||0, Number(after)||0, String(note||'')],
            function(logErr){
              if(logErr) return res.status(500).json({error:'db error'});
              res.json({ ok: true, before, after, delta, logId: this.lastID });
            }
          );
        }
      );
    });
  });
});

router.delete('/inventory/:partNumber', requireAdmin, (req,res)=>{
  db.run(`DELETE FROM inventory WHERE partNumber=?`, [req.params.partNumber], function(err){
    if(err) return res.status(500).json({error:'db error'});
    if(this.changes===0) return res.status(404).json({error:'not found'});
    res.json({ok:true});
  });
});

router.get('/inventory/:partNumber/log', requireUser, (req,res)=>{
  db.all(
    `SELECT id, partNumber, ts AS "when", user, delta, qtyBefore AS "before", qtyAfter AS "after", note
       FROM inventory_log WHERE partNumber = ? ORDER BY ts DESC LIMIT 200`,
    [req.params.partNumber],
    (err, rows)=>{
      if (err) return res.status(500).json({ error: 'db error' });
      res.json(rows || []);
    }
  );
});

router.get('/inventory-log', requireAdmin, (req,res)=>{
  const raw = String(req.query.limit || '').trim();
  const hasLimit = raw !== '';
  let sql = `SELECT id, partNumber, ts AS "when", user, delta, qtyBefore AS "before", qtyAfter AS "after", note FROM inventory_log ORDER BY ts DESC`;
  const params = [];
  if (hasLimit) {
    const limitRaw = Number(raw);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.trunc(limitRaw)) : 500;
    sql += ` LIMIT ?`;
    params.push(limit);
  }
  db.all(sql, params, (err, rows)=>{
    if (err) return res.status(500).json({ error: 'db error' });
    res.json(rows || []);
  });
});

router.delete('/inventory-log/:id', requireAdmin, (req,res)=>{
  const id = Number(req.params.id);
  if(!Number.isFinite(id)) return res.status(400).json({error:'invalid id'});
  db.run(`DELETE FROM inventory_log WHERE id = ?`, [id], function(err){
    if(err) return res.status(500).json({error:'db error'});
    if(this.changes === 0) return res.status(404).json({error:'not found'});
    res.json({ok:true});
  });
});

router.post('/inventory-log/delete-many', requireAdmin, (req,res)=>{
  const ids = Array.from(new Set((req.body?.ids || []).map(Number).filter(Number.isFinite)));
  if(!ids.length) return res.status(400).json({error:'ids required'});
  const placeholders = ids.map(() => '?').join(',');
  db.run(`DELETE FROM inventory_log WHERE id IN (${placeholders})`, ids, function(err){
    if(err) return res.status(500).json({error:'db error'});
    res.json({ok:true, deleted:this.changes || 0});
  });
});

router.put('/inventory-log/:id', requireAdmin, (req,res)=>{
  const id = Number(req.params.id);
  if(!Number.isFinite(id)) return res.status(400).json({error:'invalid id'});
  const parsedDelta = Number(req.body?.delta);
  const note = String(req.body?.note || '');
  if(!Number.isFinite(parsedDelta)) return res.status(400).json({error:'invalid delta'});
  const delta = Math.trunc(parsedDelta);

  db.get(`SELECT id, qtyBefore FROM inventory_log WHERE id = ?`, [id], (err,row)=>{
    if(err) return res.status(500).json({error:'db error'});
    if(!row) return res.status(404).json({error:'not found'});
    const before = Number(row.qtyBefore) || 0;
    const after = before + delta;
    if(after < 0) return res.status(400).json({error:'resulting after quantity cannot be negative'});
    db.run(
      `UPDATE inventory_log SET delta = ?, qtyAfter = ?, note = ? WHERE id = ?`,
      [delta, after, note, id],
      function(updateErr){
        if(updateErr) return res.status(500).json({error:'db error'});
        res.json({ok:true, id, before, after, delta});
      }
    );
  });
});

router.post('/inventory-log/combine', requireAdmin, (req,res)=>{
  const ids = Array.from(new Set((req.body?.ids || []).map(Number).filter(Number.isFinite)));
  if(ids.length < 2) return res.status(400).json({error:'select at least two movements'});
  const placeholders = ids.map(() => '?').join(',');
  db.all(
    `SELECT id, partNumber, ts, user, delta, qtyBefore, qtyAfter, note
       FROM inventory_log WHERE id IN (${placeholders}) ORDER BY ts ASC, id ASC`,
    ids,
    (err,rows)=>{
      if(err) return res.status(500).json({error:'db error'});
      if((rows || []).length !== ids.length) return res.status(404).json({error:'one or more movements were not found'});
      const firstPart = String(rows[0].partNumber || '').toLowerCase();
      if(!rows.every(r => String(r.partNumber || '').toLowerCase() === firstPart))
        return res.status(400).json({error:'selected movements must have the same part number'});

      const keeper = rows[0];
      const before = Number(keeper.qtyBefore) || 0;
      const delta = rows.reduce((sum,r) => sum + (Number(r.delta) || 0), 0);
      const after = before + delta;
      if(after < 0) return res.status(400).json({error:'combined movement would create a negative after quantity'});

      const notes = [];
      for(const row of rows){
        const n = String(row.note || '').trim();
        if(n && !notes.includes(n)) notes.push(n);
      }
      let note = notes.join(' | ');
      const combineTag = `Combined ${rows.length} movements`;
      note = note ? `${note} | ${combineTag}` : combineTag;
      const deleteIds = rows.slice(1).map(r => r.id);

      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.run(
          `UPDATE inventory_log SET delta = ?, qtyBefore = ?, qtyAfter = ?, note = ? WHERE id = ?`,
          [delta, before, after, note, keeper.id],
          function(updateErr){
            if(updateErr){ db.run('ROLLBACK'); return res.status(500).json({error:'db error'}); }
            const deletePlaceholders = deleteIds.map(() => '?').join(',');
            db.run(
              `DELETE FROM inventory_log WHERE id IN (${deletePlaceholders})`,
              deleteIds,
              function(deleteErr){
                if(deleteErr){ db.run('ROLLBACK'); return res.status(500).json({error:'db error'}); }
                db.run('COMMIT', commitErr => {
                  if(commitErr) return res.status(500).json({error:'db error'});
                  res.json({ok:true,id:keeper.id,partNumber:keeper.partNumber,combined:rows.length,delta,before,after});
                });
              }
            );
          }
        );
      });
    }
  );
});

router.post('/inventory/:partNumber/log', requireUser, (req,res)=>{
  const { delta = 0, before = 0, after = 0, note = '' } = req.body || {};
  const ts = Date.now();
  db.run(
    `INSERT INTO inventory_log (partNumber, ts, user, delta, qtyBefore, qtyAfter, note) VALUES (?,?,?,?,?,?,?)`,
    [req.params.partNumber, ts, req.user, Number(delta)||0, Number(before)||0, Number(after)||0, note],
    function(err){
      if (err) return res.status(500).json({ error: 'db error' });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

db.run(`CREATE TABLE IF NOT EXISTS bench_stock (
  partNumber TEXT PRIMARY KEY,
  description TEXT,
  location TEXT,
  manufacturer TEXT,
  qty INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER,
  updatedBy TEXT,
  notes TEXT
)`);

db.all(`PRAGMA table_info(bench_stock)`, (err, rows = []) => {
  if (err) return console.error('PRAGMA bench_stock:', err);
  const names = rows.map(c => c.name);
  if (!names.includes('notes')) {
    db.run(`ALTER TABLE bench_stock ADD COLUMN notes TEXT`);
    console.log('[db] Added notes column to bench_stock');
  }
});

router.get('/benchstock-all', requireUser, (_req,res)=>{
  db.all(
    `SELECT partNumber, description, location, manufacturer, qty, updatedAt, updatedBy, notes
       FROM bench_stock ORDER BY partNumber COLLATE NOCASE ASC`,
    [],
    (err, rows)=>{
      if (err) return res.status(500).json({ error:'db error' });
      res.json(rows || []);
    }
  );
});

router.get('/benchstock/:partNumber', requireUser, (req,res)=>{
  db.get(
    `SELECT partNumber, description, location, manufacturer, qty, updatedAt, updatedBy, notes
       FROM bench_stock WHERE partNumber = ?`,
    [req.params.partNumber],
    (err, row)=>{
      if (err) return res.status(500).json({ error:'db error' });
      if (!row) return res.status(404).json({ error:'not found'});
      res.json(row);
    }
  );
});

router.post('/benchstock', requireAdmin, (req,res)=>{
  const { partNumber, description='', location='', manufacturer='', qty=0, notes='' } = req.body || {};
  const pn = String(partNumber || '').trim();
  if (!pn) return res.status(400).json({ error:'partNumber required' });
  const parsedQty = Number(qty);
  if (!Number.isFinite(parsedQty) || parsedQty < 0) return res.status(400).json({ error:'invalid qty' });
  const now = Date.now();
  db.run(
    `INSERT INTO bench_stock (partNumber, description, location, manufacturer, qty, updatedAt, updatedBy, notes) VALUES (?,?,?,?,?,?,?,?)`,
    [pn, String(description||'').trim(), String(location||'').trim(), String(manufacturer||'').trim(), Math.trunc(parsedQty), now, req.user, String(notes||'').trim()],
    function(err){
      if (err) {
        if (String(err.message || '').includes('UNIQUE')) return res.status(409).json({ error:'exists' });
        return res.status(500).json({ error:'db error' });
      }
      res.json({ ok:true, partNumber: pn });
    }
  );
});

router.put('/benchstock/:partNumber', requireAdmin, (req,res)=>{
  const { description='', location='', manufacturer='', qty=0, notes='' } = req.body || {};
  const parsedQty = Number(qty);
  if (!Number.isFinite(parsedQty) || parsedQty < 0) return res.status(400).json({ error:'invalid qty' });
  const now = Date.now();
  db.run(
    `UPDATE bench_stock SET description = ?, location = ?, manufacturer = ?, qty = ?, updatedAt = ?, updatedBy = ?, notes = ? WHERE partNumber = ?`,
    [String(description||'').trim(), String(location||'').trim(), String(manufacturer||'').trim(), Math.trunc(parsedQty), now, req.user, String(notes||'').trim(), req.params.partNumber],
    function(err){
      if (err) return res.status(500).json({ error:'db error' });
      if (this.changes === 0) return res.status(404).json({ error:'not found' });
      res.json({ ok:true, partNumber: req.params.partNumber });
    }
  );
});

router.delete('/benchstock/:partNumber', requireAdmin, (req,res)=>{
  db.run(`DELETE FROM bench_stock WHERE partNumber = ?`, [req.params.partNumber], function(err){
    if (err) return res.status(500).json({ error:'db error' });
    if (this.changes === 0) return res.status(404).json({ error:'not found' });
    res.json({ ok:true });
  });
});

module.exports = router;
