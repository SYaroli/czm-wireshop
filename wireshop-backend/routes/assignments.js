// routes/assignments.js
const express = require('express');
const fs = require('fs').promises;
const path = require('path');

const router = express.Router();

// very light "auth"
function requireUser(req, res, next){
  const u = (req.headers['x-user']||'').trim();
  if (!u) return res.status(401).json({ error:'x-user required' });
  req.user = u;
  next();
}
function requireAdmin(req, res, next){
  const u = (req.headers['x-user']||'').trim();
  if (!u) return res.status(401).json({ error:'x-user required' });
  const admins = (process.env.ADMIN_USERS||'').split(',').map(s=>s.trim()).filter(Boolean);
  if (admins.length>0 ? admins.includes(u) : true) {
    req.user = u; return next();
  }
  return res.status(403).json({ error:'admin only' });
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const ASSIGN_FILE = path.join(DATA_DIR, 'assignments.json');
const REQ_FILE = path.join(DATA_DIR, 'assignment_requests.json');

async function ensureFiles(){
  await fs.mkdir(DATA_DIR, { recursive:true });
  try{ await fs.access(ASSIGN_FILE); } catch { await fs.writeFile(ASSIGN_FILE, JSON.stringify({ seq:1, items:[] }, null, 2)); }
  try{ await fs.access(REQ_FILE); } catch { await fs.writeFile(REQ_FILE, JSON.stringify({ seq:1, items:[] }, null, 2)); }
}
async function readJson(p){ await ensureFiles(); const t = await fs.readFile(p, 'utf8'); return JSON.parse(t); }
async function writeJson(p, obj){ await fs.writeFile(p, JSON.stringify(obj, null, 2)); }

function sanitizeAssignment(a){
  return {
    id: a.id, createdAt: a.createdAt, createdBy: a.createdBy,
    username: a.username, partNumber: a.partNumber || null, printName: a.printName || null,
    expectedMinutes: a.expectedMinutes ?? null, dueDate: a.dueDate ?? null,
    notes: a.notes || '', status: a.status || 'Open', updates: a.updates || []
  };
}

// GET /api/assignments?username=&status=
router.get('/assignments', requireUser, async (req, res)=>{
  const db = await readJson(ASSIGN_FILE);
  let rows = db.items.map(sanitizeAssignment);
  if (req.query.username) rows = rows.filter(r=>r.username===req.query.username);
  if (req.query.status) rows = rows.filter(r=>r.status===req.query.status);
  rows.sort((a,b)=>b.createdAt - a.createdAt);
  res.json(rows);
});

// GET /api/assignments/me
router.get('/assignments/me', requireUser, async (req, res)=>{
  const db = await readJson(ASSIGN_FILE);
  const rows = db.items.filter(a=>a.username===req.user).map(sanitizeAssignment).sort((a,b)=>b.createdAt - a.createdAt);
  res.json(rows);
});

// POST /api/assignments
router.post('/assignments', requireUser, async (req, res)=>{
  const { username, partNumber, expectedMinutes, dueDate, notes } = req.body || {};
  if (!username) return res.status(400).json({ error:'username required' });
  const db = await readJson(ASSIGN_FILE);
  const id = db.seq++;
  const row = {
    id, createdAt: Date.now(), createdBy: req.user,
    username, partNumber: partNumber||null, printName: req.body.printName||null,
    expectedMinutes: Number.isFinite(expectedMinutes)? expectedMinutes : null,
    dueDate: Number.isFinite(dueDate)? dueDate : null,
    notes: notes||'', status:'Open', updates:[{ at: Date.now(), user:req.user, action:'Create'}]
  };
  db.items.unshift(row);
  await writeJson(ASSIGN_FILE, db);
  res.status(201).json(sanitizeAssignment(row));
});

// PATCH /api/assignments/:id   { status, notes }
router.patch('/assignments/:id', requireUser, async (req, res)=>{
  const id = Number(req.params.id);
  const db = await readJson(ASSIGN_FILE);
  const row = db.items.find(x=>x.id===id);
  if (!row) return res.status(404).json({ error:'not found' });
  const validStatuses = new Set(['Open','InProgress','Completed','Canceled']);
  const updates = [];
  if (req.body.status && validStatuses.has(req.body.status) && req.body.status!==row.status){
    row.status = req.body.status;
    updates.push({ at: Date.now(), user:req.user, action:`Status:${row.status}` });
  }
  if (typeof req.body.notes === 'string' && req.body.notes !== row.notes){
    row.notes = req.body.notes;
    updates.push({ at: Date.now(), user:req.user, action:'Notes' });
  }
  row.updates.push(...updates);
  await writeJson(ASSIGN_FILE, db);
  res.json(sanitizeAssignment(row));
});

// DELETE /api/assignments/:id
router.delete('/assignments/:id', requireUser, async (req, res)=>{
  const id = Number(req.params.id);
  const db = await readJson(ASSIGN_FILE);
  const n = db.items.length;
  db.items = db.items.filter(x=>x.id!==id);
  if (db.items.length===n) return res.status(404).json({ error:'not found' });
  await writeJson(ASSIGN_FILE, db);
  res.json({ ok:true });
});

// ===== Requests =====

// GET /api/assignments/requests
router.get('/assignments/requests', requireUser, async (req, res)=>{
  const db = await readJson(REQ_FILE);
  const rows = db.items.filter(r=>r.status==='Pending').sort((a,b)=>b.createdAt - a.createdAt);
  res.json(rows);
});

// POST /api/assignments/requests
router.post('/assignments/requests', requireUser, async (req, res)=>{
  const { description, partNumber, minutes, notes } = req.body || {};
  if (!description && !partNumber) return res.status(400).json({ error:'description or partNumber required' });
  const db = await readJson(REQ_FILE);
  const id = db.seq++;
  const row = {
    id, createdAt: Date.now(), username: req.user,
    description: description || '', partNumber: partNumber || null,
    minutes: Number.isFinite(minutes)? minutes : null,
    notes: notes || '', status:'Pending'
  };
  db.items.unshift(row);
  await writeJson(REQ_FILE, db);
  res.status(201).json(row);
});

// PATCH /api/assignments/requests/:id/approve
router.patch('/assignments/requests/:id/approve', requireUser, async (req, res)=>{
  const id = Number(req.params.id);
  const rq = await readJson(REQ_FILE);
  const it = rq.items.find(x=>x.id===id && x.status==='Pending');
  if (!it) return res.status(404).json({ error:'not found' });
  it.status = 'Approved';
  await writeJson(REQ_FILE, rq);

  const as = await readJson(ASSIGN_FILE);
  const aid = as.seq++;
  const row = {
    id: aid, createdAt: Date.now(), createdBy: req.user,
    username: it.username, partNumber: it.partNumber || null, printName: null,
    expectedMinutes: it.minutes ?? null, dueDate: null,
    notes: it.description || it.notes || '', status:'Completed',
    updates:[{ at: Date.now(), user:req.user, action:'ApprovedFromRequest' }]
  };
  as.items.unshift(row);
  await writeJson(ASSIGN_FILE, as);

  res.json({ ok:true, assignmentId: aid });
});

// PATCH /api/assignments/requests/:id/reject
router.patch('/assignments/requests/:id/reject', requireUser, async (req, res)=>{
  const id = Number(req.params.id);
  const rq = await readJson(REQ_FILE);
  const it = rq.items.find(x=>x.id===id && x.status==='Pending');
  if (!it) return res.status(404).json({ error:'not found' });
  it.status = 'Rejected';
  await writeJson(REQ_FILE, rq);
  res.json({ ok:true });
});

module.exports = router;
