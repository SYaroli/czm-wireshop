// server.js — backend entry with Assignments mounted (Render-friendly)

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// --- Basic middleware
app.use(cors({
  origin: true,
  credentials: false
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// --- Health check (used by your frontends)
app.get('/healthz', (req, res) => {
  res.json({ ok: true, archiveReady: true });
});

// --- Mount existing routers if they exist (optional, non-fatal)
function tryMount(mountPoint, modPath, label) {
  try {
    const r = require(modPath);
    app.use(mountPoint, r);
    console.log(`[mount] ${label || modPath} at ${mountPoint}`);
  } catch (err) {
    console.log(`[mount] skipped ${label || modPath}: ${err.message}`);
  }
}

// If you already have these, great; if not, this just logs and continues.
// Adjust/remove these two lines to match your real routes.
tryMount('/api/jobs', './routes/jobs', 'jobs');
tryMount('/api/archive', './routes/archive', 'archive');

// --- Mount Assignments (this is the whole point)
const assignments = require('./routes/assignments');
app.use('/api', assignments);

// --- Static (optional; serves your built frontend if you deploy it here)
const publicDir = path.join(process.cwd(), 'public');
app.use(express.static(publicDir));

// --- 404 for unknown API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// --- Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Wireshop backend listening on :${PORT}`);
});
