// server.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// DB (SQLite for now)
const db = require('./db');

// Parsers
app.use(bodyParser.json());

// CORS — permissive for first deploy; we'll lock it down after it’s live
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  credentials: false
}));

// Health check for Render
app.get('/health', (req, res) => res.status(200).send('ok'));

// Routes
const jobsRouter = require('./routes/jobs');
app.use('/api/jobs', jobsRouter);

// Root test
app.get('/', (req, res) => {
  res.send('Wireshop Backend Running');
});

// Legacy endpoints (intentionally 404 with hints)
app.post('/api/log', (req, res) => {
  res.status(404).json({ error: 'Use /api/jobs/log instead' });
});

app.get('/api/logs', (req, res) => {
  res.status(404).json({ error: 'Use /api/jobs/logs or /api/jobs/logs/:username' });
});

app.delete('/api/delete-logs', (req, res) => {
  res.status(404).json({ error: 'Use /api/jobs/delete-logs/:username or /api/jobs/admin/clear-logs' });
});

app.get('/api/test-db', (req, res) => {
  db.get('SELECT COUNT(*) as count FROM jobs', (err, row) => {
    if (err) return res.status(500).json({ error: 'DB test failed' });
    res.json({ count: row.count });
  });
});

// Start
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
