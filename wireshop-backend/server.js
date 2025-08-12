// server.js  (complete file)
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// init DB (creates tables)
require('./db');

app.use(bodyParser.json());
app.use(cors({ origin: (o, cb) => cb(null, true), credentials: false }));

app.get('/health', (req, res) => res.status(200).send('ok'));

// Routers
const jobsRouter = require('./routes/jobs');
const usersRouter = require('./routes/users');

app.use('/api/jobs', jobsRouter);
app.use('/api/users', usersRouter);

app.get('/', (req, res) => res.send('Wireshop Backend Running'));

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
