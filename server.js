'use strict';

// Entry point for the QueueStorm Investigator API.

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const analyzeRouter = require('./routes/analyze');

const app = express();

// Trust proxy if behind a load balancer (Render uses one).
app.set('trust proxy', 1);

app.disable('x-powered-by');
app.use(cors());

// Controlled JSON parsing. Bad JSON => 400, not a server crash.
app.use(express.json({
  limit: '256kb',
  verify: (req, res, buf) => {
    // touch the buffer to trigger JSON.parse inside express
    if (buf && buf.length) {
      try {
        // no-op: express.json will validate, but we keep verify for future hooks
        JSON.parse(buf.toString('utf8'));
      } catch (e) {
        // Throwing here makes express emit a SyntaxError we can catch below.
        throw new SyntaxError('Invalid JSON');
      }
    }
  },
}));

// JSON parse error handler -> 400.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large.' });
  }
  if (err && err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Malformed JSON body.' });
  }
  return next(err);
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Static tester page. The page is plain HTML/CSS/JS under public/.
// index.html is served at GET /. Other assets (none today) are served
// directly from public/. All /api/* style endpoints keep working.
const path = require('path');
app.use('/static', express.static(path.join(__dirname, 'public'), { fallthrough: true, index: false }));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/', analyzeRouter);

// Generic 404 for unknown routes.
app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Final error handler. Never leak stack traces or secrets.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  res.status(500).json({ error: 'Internal error.' });
});

const PORT = Number(process.env.PORT) || 8000;
const HOST = '0.0.0.0';

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`QueueStorm Investigator API listening on http://${HOST}:${PORT}`);
  });
}

module.exports = app;
