import { createServer } from 'node:http';
import path from 'node:path';
import { openDb, seed } from './src/db.js';
import { createApp } from './src/app.js';

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(process.cwd(), 'data', 'docs-lite.db');

const db = openDb(DB_FILE);
seed(db);

const server = createServer(createApp({ db }));
server.listen(PORT, () => {
  console.log(`Docs Lite running at http://localhost:${PORT}`);
  console.log(`Database: ${DB_FILE}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
