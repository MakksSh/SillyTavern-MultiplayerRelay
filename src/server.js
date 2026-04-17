const path = require('path');
const http = require('http');
const express = require('express');
const dotenv = require('dotenv');
const { attachWebSocketServer } = require('./ws');
const logger = require('./logger');

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

const app = express();
const server = http.createServer(app);
const publicDir = path.join(__dirname, '..', 'public');

app.use(express.static(publicDir));
app.use((request, response, next) => {
  const startedAt = Date.now();

  response.on('finish', () => {
    logger.info('http.request.completed', {
      method: request.method,
      path: request.originalUrl,
      statusCode: response.statusCode,
      durationMs: Date.now() - startedAt,
      remoteAddress: request.ip,
    });
  });

  next();
});

app.get('/health', (_request, response) => {
  response.json({ ok: true });
});

app.get('/', (_request, response) => {
  response.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/admin', (_request, response) => {
  response.sendFile(path.join(publicDir, 'admin.html'));
});

app.get('/room/:roomId', (_request, response) => {
  response.sendFile(path.join(publicDir, 'room.html'));
});

attachWebSocketServer(server, {
  adminKey: ADMIN_KEY,
  publicBaseUrl: PUBLIC_BASE_URL,
});

server.on('error', (error) => {
  logger.error('server.listen.failed', { error });
});

server.listen(PORT, () => {
  logger.info('server.started', {
    port: PORT,
    publicBaseUrl: PUBLIC_BASE_URL,
    adminKeyConfigured: Boolean(String(ADMIN_KEY || '').trim()),
    logLevel: String(process.env.LOG_LEVEL || 'info'),
  });
});
