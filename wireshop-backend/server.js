// server.js — clean boot, two routers, CORS, health
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// init DB (creates/migrates tables)
require('./db');

app.use(bodyParser.json());
app.use(cors({ origin: (o, cb) => cb(null, true), credentials: false }));

app.get('/health', (_req, res) => res.status(200).send('ok'));

// Routers
app.use('/api/jobs',   require('./routes/jobs'));
app.use('/api/users',  require('./routes/users'));

app.get('/', (_req, res) => res.send('Wireshop Backend Running'));

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
