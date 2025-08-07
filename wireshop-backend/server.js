// server.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Database setup (SQLite) - Use db.js for consistency
const db = require('./db');

app.use(cors());
app.use(bodyParser.json());

// Mount jobs routes
const jobsRouter = require('./routes/jobs');
app.use('/api/jobs', jobsRouter); // Match frontend's /api/jobs prefix

// GET / - Test endpoint
app.get('/', (req, res) => {
  res.send('Wireshop Backend Running');
});

// Legacy endpoints (redirect to new routes)
app.post('/api/log', (req, res) => {
  res.status(404).json({ error: 'Use /api/jobs/log instead' });
});

app.get('/api/logs', (req, res) => {
  res.status(404).json({ error: 'Use /api/jobs/logs instead' });
});

app.delete('/api/delete-logs', (req, res) => {
  res.status(404).json({ error: 'Use /api/jobs/delete-logs if implemented' });
});

app.get('/api/test-db', (req, res) => {
  db.get('SELECT COUNT(*) as count FROM jobs', (err, row) => {
    if (err) {
      console.error('Error testing DB:', err);
      return res.status(500).json({ error: 'DB test failed' });
    }
    console.log('DB test: ', row.count, 'jobs');
    res.json({ count: row.count });
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});