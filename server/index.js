'use strict';

const path = require('path');
const { Store } = require('./store');
const { OpenAIClient } = require('./ai');
const { createApp } = require('./app');

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(path.join(__dirname, '..', '.env'));
  } catch {
    // No .env file - rely on the real environment.
  }
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'journey.json');

const store = new Store({ file: DATA_FILE });
const ai = new OpenAIClient();
const app = createApp({ store, ai });

app.listen(PORT, HOST, () => {
  console.log(`Journey is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!ai.configured) console.warn('Warning: OPENAI_API_KEY is not set. Conversations will not work until it is configured.');
});
