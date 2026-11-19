import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashPassword } from './auth.js';

const SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    id         TEXT PRIMARY KEY,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    content    TEXT NOT NULL DEFAULT '',
    version    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);

  CREATE TABLE IF NOT EXISTS shares (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
    created_at  TEXT NOT NULL,
    PRIMARY KEY (document_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

export const DEMO_PASSWORD = 'demo1234';
export const DEMO_USERS = [
  { email: 'alice@demo.test', name: 'Alice Chen' },
  { email: 'bob@demo.test', name: 'Bob Patel' },
  { email: 'carol@demo.test', name: 'Carol Diaz' },
];

const WELCOME = `
<h1>Welcome to Docs Lite</h1>
<p>This document is owned by <strong>Alice</strong> and shared with <strong>Bob</strong> as an <em>editor</em> and <strong>Carol</strong> as a <em>viewer</em>.</p>
<h2>Try it</h2>
<ul>
  <li>Format text with the toolbar or <strong>Ctrl/Cmd + B</strong>, <em>I</em>, <u>U</u>.</li>
  <li>Changes save automatically. Refresh the page and they are still here.</li>
  <li>Sign in as Bob in another browser to see the shared copy.</li>
</ul>
<ol>
  <li>Create a document from the home page.</li>
  <li>Import a .txt, .md or .docx file.</li>
  <li>Share it with another demo user.</li>
</ol>
`.trim();

/** Idempotent: creates demo users and one shared welcome doc on first boot. */
export function seed(db) {
  const insertUser = db.prepare(
    'INSERT OR IGNORE INTO users (email, name, password_hash) VALUES (?, ?, ?)'
  );
  const hash = hashPassword(DEMO_PASSWORD);
  for (const u of DEMO_USERS) insertUser.run(u.email, u.name, hash);

  const alice = db.prepare('SELECT id FROM users WHERE email = ?').get('alice@demo.test');
  const hasDocs = db.prepare('SELECT 1 FROM documents WHERE owner_id = ? LIMIT 1').get(alice.id);
  if (hasDocs) return;

  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO documents (id, owner_id, title, content, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, alice.id, 'Welcome to Docs Lite', WELCOME, now, now, alice.id);

  const share = db.prepare(
    'INSERT INTO shares (document_id, user_id, role, created_at) VALUES (?, ?, ?, ?)'
  );
  const userId = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  share.run(id, userId('bob@demo.test'), 'editor', now);
  share.run(id, userId('carol@demo.test'), 'viewer', now);
}
