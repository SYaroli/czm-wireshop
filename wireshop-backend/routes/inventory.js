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
  notes TEXT,
  updatedAt INTEGER,
  updatedBy TEXT
)`);

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

  const hasDelta = req.body?.delta !== undefined && req.body?.delta !== null && req.body?.delta !== '';
  const parsedDelta = hasDelta ? Number(req.body.delta) : null;
  const note = String(req.body?.note || '');
  if(hasDelta && !Number.isFinite(parsedDelta)) return res.status(400).json({error:'invalid delta'});

  db.get(`SELECT id, qtyBefore, delta FROM inventory_log WHERE id = ?`, [id], (err,row)=>{
    if(err) return res.status(500).json({error:'db error'});
    if(!row) return res.status(404).json({error:'not found'});

    // Note-only edits keep the movement's existing delta unchanged.
    const delta = hasDelta ? Math.trunc(parsedDelta) : Math.trunc(Number(row.delta) || 0);
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

const runBenchStockMigration = sql => new Promise((resolve, reject) => {
  db.run(sql, err => err ? reject(err) : resolve());
});

const benchStockReady = (async () => {
  await runBenchStockMigration(`CREATE TABLE IF NOT EXISTS bench_stock (
    partNumber TEXT PRIMARY KEY,
    description TEXT,
    location TEXT,
    manufacturer TEXT,
    qty INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER,
    updatedBy TEXT,
    notes TEXT,
    unitCost REAL,
    costUnit TEXT NOT NULL DEFAULT 'ea',
    photo BLOB,
    photoType TEXT
  )`);
  const rows = await new Promise((resolve, reject) => {
    db.all('PRAGMA table_info(bench_stock)', (err, rows) => err ? reject(err) : resolve(rows));
  });
  const names = new Set(rows.map(column => column.name));
  for (const [name, type] of [['notes', 'TEXT'], ['unitCost', 'REAL'], ['costUnit', "TEXT NOT NULL DEFAULT 'ea'"], ['photo', 'BLOB'], ['photoType', 'TEXT']]) {
    if (!names.has(name)) await runBenchStockMigration(`ALTER TABLE bench_stock ADD COLUMN ${name} ${type}`);
  }
  return true;
})().catch(err => {
  console.error('Bench stock schema migration failed:', err);
  return false;
});

router.use(/^\/benchstock(?:-all|\/|$)/, async (_req, res, next) => {
  if (!await benchStockReady) return res.status(503).json({ error:'Bench stock storage unavailable' });
  next();
});

function parseBenchStockCost(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  if (!['string', 'number'].includes(typeof value)) return NaN;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : NaN;
}

router.get('/benchstock-all', requireUser, (_req,res)=>{
  db.all(
    `SELECT partNumber, description, location, manufacturer, qty, updatedAt, updatedBy, notes, unitCost, costUnit, photo IS NOT NULL AS hasPhoto
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
    `SELECT partNumber, description, location, manufacturer, qty, updatedAt, updatedBy, notes, unitCost, costUnit, photo IS NOT NULL AS hasPhoto
       FROM bench_stock WHERE partNumber = ?`,
    [req.params.partNumber],
    (err, row)=>{
      if (err) return res.status(500).json({ error:'db error' });
      if (!row) return res.status(404).json({ error:'not found' });
      res.json(row);
    }
  );
});

router.get('/benchstock/:partNumber/photo', requireUser, (req, res) => {
  db.get('SELECT photo, photoType FROM bench_stock WHERE partNumber = ?', [req.params.partNumber], (err, row) => {
    if (err) return res.status(500).json({ error:'db error' });
    if (!row?.photo) return res.sendStatus(404);
    res.set({ 'Content-Type': row.photoType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send(row.photo);
  });
});

function parseBenchStockPhoto(value) {
  if (value == null) return { bytes: null, type: null };
  if (typeof value !== 'string' || value.length > 1398130) return null;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  const type = match[1];
  if (bytes.length > 1024 * 1024) return null;
  const valid = type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : type === 'image/jpeg' ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
    : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return valid ? { bytes, type } : null;
}

router.post('/benchstock', requireAdmin, (req,res)=>{
  const { partNumber, description='', location='', manufacturer='', qty=0, notes='', unitCost, costUnit, photo } = req.body || {};
  const parsedPhoto = parseBenchStockPhoto(photo);
  if (!parsedPhoto) return res.status(400).json({ error:'Upload a JPG, PNG or WebP image up to 1 MB' });
  const parsedCost = parseBenchStockCost(unitCost);
  if (Number.isNaN(parsedCost)) return res.status(400).json({ error:'Unit cost must be 0 or higher' });
  if (costUnit !== undefined && !['ea', 'ft'].includes(costUnit)) return res.status(400).json({ error:'Invalid cost unit' });
  const pn = String(partNumber || '').trim();
  if (!pn) return res.status(400).json({ error:'partNumber required' });
  const parsedQty = Number(qty);
  if (!Number.isFinite(parsedQty) || parsedQty < 0) return res.status(400).json({ error:'invalid qty' });
  const now = Date.now();
  db.run(
    `INSERT INTO bench_stock (partNumber, description, location, manufacturer, qty, updatedAt, updatedBy, notes, unitCost, costUnit, photo, photoType) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [pn, String(description||'').trim(), String(location||'').trim(), String(manufacturer||'').trim(), Math.trunc(parsedQty), now, req.user, String(notes||'').trim(), parsedCost, costUnit ?? 'ea', parsedPhoto.bytes, parsedPhoto.type],
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
  const { partNumber, description='', location='', manufacturer='', qty, notes='', unitCost, costUnit, photo } = req.body || {};
  const pn = partNumber === undefined ? req.params.partNumber : typeof partNumber === 'string' ? partNumber.trim() : '';
  if (!pn) return res.status(400).json({ error:'Part number is required' });
  const parsedPhoto = parseBenchStockPhoto(photo);
  if (!parsedPhoto) return res.status(400).json({ error:'Upload a JPG, PNG or WebP image up to 1 MB' });
  const parsedCost = parseBenchStockCost(unitCost);
  if (Number.isNaN(parsedCost)) return res.status(400).json({ error:'Unit cost must be 0 or higher' });
  if (costUnit !== undefined && !['ea', 'ft'].includes(costUnit)) return res.status(400).json({ error:'Invalid cost unit' });
  const parsedQty = qty === undefined ? null : Number(qty);
  if (parsedQty !== null && (!Number.isFinite(parsedQty) || parsedQty < 0)) return res.status(400).json({ error:'invalid qty' });
  const now = Date.now();
  db.run(
    `UPDATE bench_stock SET partNumber = ?, description = ?, location = ?, manufacturer = ?, qty = COALESCE(?, qty), updatedAt = ?, updatedBy = ?, notes = ?, unitCost = CASE WHEN ? THEN ? ELSE unitCost END, costUnit = COALESCE(?, costUnit), photo = CASE WHEN ? THEN ? ELSE photo END, photoType = CASE WHEN ? THEN ? ELSE photoType END WHERE partNumber = ?`,
    [pn, String(description||'').trim(), String(location||'').trim(), String(manufacturer||'').trim(), parsedQty === null ? null : Math.trunc(parsedQty), now, req.user, String(notes||'').trim(), Number(unitCost !== undefined), parsedCost, costUnit ?? null, Number(photo !== undefined), parsedPhoto.bytes, Number(photo !== undefined), parsedPhoto.type, req.params.partNumber],
    function(err){
      if (err) {
        if (err.code === 'SQLITE_CONSTRAINT' && /bench_stock\.partNumber/.test(err.message)) {
          return res.status(409).json({ error:'That part number already exists in Bench Stock' });
        }
        return res.status(500).json({ error:'db error' });
      }
      if (this.changes === 0) return res.status(404).json({ error:'not found' });
      res.json({ ok:true, partNumber: pn });
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
