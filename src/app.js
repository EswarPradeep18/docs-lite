// HTTP layer: a small explicit router over node:http. Each route declares
// whether it needs a signed-in user; document routes resolve access through
// permissions.js before touching data.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sanitizeHtml } from '../public/shared/sanitize.js';
import { importFile, titleFromFilename, ImportError, SUPPORTED_EXTENSIONS } from './importers.js';
import {
  COOKIE_NAME,
  createSession,
  destroySession,
  parseCookies,
  sessionCookie,
  userForToken,
  verifyPassword,
} from './auth.js';
import { resolveAccess, canRead, canEdit, canManage, ROLES } from './permissions.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export const LIMITS = {
  jsonBytes: 2 * 1024 * 1024,
  uploadBytes: 5 * 1024 * 1024,
  contentChars: 1_000_000,
  titleChars: 200,
};

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function sendJson(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

async function readBody(req, limit) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) throw new HttpError(413, `Request is too large (max ${Math.round(limit / 1024 / 1024)} MB)`);
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new HttpError(413, `Request is too large (max ${Math.round(limit / 1024 / 1024)} MB)`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const type = req.headers['content-type'] || '';
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Expected application/json');
  const buf = await readBody(req, LIMITS.jsonBytes);
  if (!buf.length) return {};
  try {
    const data = JSON.parse(buf.toString('utf8'));
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}

// ------------------------------------------------------------- validation

function validateTitle(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Title must be text');
  const title = value.trim().replace(/\s+/g, ' ');
  if (!title) throw new HttpError(400, 'Title cannot be empty');
  if (title.length > LIMITS.titleChars) {
    throw new HttpError(400, `Title must be ${LIMITS.titleChars} characters or fewer`);
  }
  return title;
}

function validateContent(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Content must be an HTML string');
  if (value.length > LIMITS.contentChars) throw new HttpError(413, 'Document is too large to save');
  return sanitizeHtml(value);
}

// ------------------------------------------------------------ serializers

function serializeDocument(db, doc, role) {
  const owner = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(doc.owner_id);
  const editor = doc.updated_by
    ? db.prepare('SELECT name FROM users WHERE id = ?').get(doc.updated_by)
    : null;
  const out = {
    id: doc.id,
    title: doc.title,
    content: doc.content,
    version: doc.version,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
    updatedBy: editor?.name ?? null,
    owner: { id: owner.id, name: owner.name, email: owner.email },
    role,
  };
  if (canManage(role)) out.shares = listShares(db, doc.id);
  return out;
}

function listShares(db, documentId) {
  return db
    .prepare(
      `SELECT u.id AS userId, u.name, u.email, s.role
         FROM shares s JOIN users u ON u.id = s.user_id
        WHERE s.document_id = ? ORDER BY u.name`
    )
    .all(documentId);
}

function requireDoc(db, id, user, check, action) {
  const { doc, role } = resolveAccess(db, id, user.id);
  // No access is reported as 404 so document IDs can't be probed.
  if (!doc || !canRead(role)) throw new HttpError(404, 'Document not found');
  if (!check(role)) throw new HttpError(403, `You don't have permission to ${action} this document`);
  return { doc, role };
}

// ---------------------------------------------------------------- handlers

function login({ db, body, req, res }) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) throw new HttpError(400, 'Email and password are required');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new HttpError(401, 'Incorrect email or password');
  }
  const { token, maxAgeSeconds } = createSession(db, user.id);
  const secure = req.headers['x-forwarded-proto'] === 'https';
  sendJson(res, 200, { user: { id: user.id, name: user.name, email: user.email } }, {
    'Set-Cookie': sessionCookie(token, maxAgeSeconds, secure),
  });
}

function logout({ db, req, res }) {
  destroySession(db, parseCookies(req.headers.cookie)[COOKIE_NAME]);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
}

// Returns { user: null } instead of 401 so the app can check sign-in quietly.
function me({ db, req }) {
  return { user: userForToken(db, parseCookies(req.headers.cookie)[COOKIE_NAME]) };
}

function listUsers({ db, user }) {
  // Directory of people you can share with (fine for a demo workspace).
  return {
    users: db.prepare('SELECT id, name, email FROM users WHERE id != ? ORDER BY name').all(user.id),
  };
}

function listDocuments({ db, user }) {
  const owned = db
    .prepare(
      `SELECT d.id, d.title, d.updated_at AS updatedAt,
              (SELECT COUNT(*) FROM shares s WHERE s.document_id = d.id) AS shareCount
         FROM documents d WHERE d.owner_id = ? ORDER BY d.updated_at DESC`
    )
    .all(user.id);
  const shared = db
    .prepare(
      `SELECT d.id, d.title, d.updated_at AS updatedAt, s.role, u.name AS ownerName
         FROM shares s
         JOIN documents d ON d.id = s.document_id
         JOIN users u ON u.id = d.owner_id
        WHERE s.user_id = ? ORDER BY d.updated_at DESC`
    )
    .all(user.id);
  return { owned, shared };
}

function insertDocument(db, user, title, content) {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO documents (id, owner_id, title, content, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, user.id, title, content, now, now, user.id);
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
}

function createDocument({ db, user, body, res }) {
  const title = body.title === undefined ? 'Untitled document' : validateTitle(body.title);
  const content = body.content === undefined ? '' : validateContent(body.content);
  const doc = insertDocument(db, user, title, content);
  sendJson(res, 201, { document: serializeDocument(db, doc, 'owner') });
}

function getDocument({ db, user, params }) {
  const { doc, role } = requireDoc(db, params.id, user, canRead, 'view');
  return { document: serializeDocument(db, doc, role) };
}

function updateDocument({ db, user, params, body }) {
  const { doc, role } = requireDoc(db, params.id, user, canEdit, 'edit');
  const hasTitle = body.title !== undefined;
  const hasContent = body.content !== undefined;
  if (!hasTitle && !hasContent) throw new HttpError(400, 'Nothing to update');

  const now = new Date().toISOString();
  if (hasTitle) {
    // Renames never conflict with content edits, so they don't bump version.
    db.prepare('UPDATE documents SET title = ?, updated_at = ? WHERE id = ?').run(
      validateTitle(body.title),
      now,
      doc.id
    );
  }
  if (hasContent) {
    if (!Number.isInteger(body.baseVersion)) {
      throw new HttpError(400, 'baseVersion is required when saving content');
    }
    const content = validateContent(body.content);
    // Optimistic concurrency: the update only applies if nobody saved in between.
    const result = db
      .prepare(
        `UPDATE documents SET content = ?, version = version + 1, updated_at = ?, updated_by = ?
          WHERE id = ? AND version = ?`
      )
      .run(content, now, user.id, doc.id, body.baseVersion);
    if (result.changes === 0) {
      const current = db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id);
      throw new HttpError(409, 'This document was changed by someone else since you opened it', {
        document: serializeDocument(db, current, role),
      });
    }
  }
  const updated = db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id);
  return { document: serializeDocument(db, updated, role) };
}

function deleteDocument({ db, user, params }) {
  const { doc } = requireDoc(db, params.id, user, canManage, 'delete');
  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  return { ok: true };
}

function addShare({ db, user, params, body }) {
  const { doc } = requireDoc(db, params.id, user, canManage, 'share');
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const role = body.role ?? 'viewer';
  if (!email) throw new HttpError(400, 'Enter the email of the person to share with');
  if (!ROLES.includes(role)) throw new HttpError(400, `Role must be one of: ${ROLES.join(', ')}`);
  const target = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
  if (!target) throw new HttpError(404, `No user with email ${email}`);
  if (target.id === doc.owner_id) throw new HttpError(400, 'You already own this document');

  db.prepare(
    `INSERT INTO shares (document_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (document_id, user_id) DO UPDATE SET role = excluded.role`
  ).run(doc.id, target.id, role, new Date().toISOString());
  return { shares: listShares(db, doc.id) };
}

function removeShare({ db, user, params }) {
  const { doc } = requireDoc(db, params.id, user, canManage, 'share');
  const userId = Number(params.userId);
  if (!Number.isInteger(userId)) throw new HttpError(400, 'Invalid user');
  db.prepare('DELETE FROM shares WHERE document_id = ? AND user_id = ?').run(doc.id, userId);
  return { shares: listShares(db, doc.id) };
}

function uploadFilename(req) {
  const raw = req.headers['x-filename'];
  if (!raw) throw new HttpError(400, 'Missing file name');
  try {
    return decodeURIComponent(String(raw));
  } catch {
    throw new HttpError(400, 'Invalid file name');
  }
}

function convertUpload(filename, buffer) {
  try {
    return importFile(filename, buffer);
  } catch (e) {
    if (e instanceof ImportError) throw new HttpError(422, e.message);
    throw e;
  }
}

async function importAsNew({ db, user, req, res }) {
  const filename = uploadFilename(req);
  const buffer = await readBody(req, LIMITS.uploadBytes);
  const content = convertUpload(filename, buffer);
  const doc = insertDocument(db, user, titleFromFilename(filename), content);
  sendJson(res, 201, { document: serializeDocument(db, doc, 'owner') });
}

async function importIntoExisting({ db, user, req, params }) {
  const { doc, role } = requireDoc(db, params.id, user, canEdit, 'edit');
  const filename = uploadFilename(req);
  const buffer = await readBody(req, LIMITS.uploadBytes);
  const imported = convertUpload(filename, buffer);
  const merged = `${doc.content}\n${imported}`;
  if (merged.length > LIMITS.contentChars) throw new HttpError(413, 'Document would be too large after import');
  db.prepare(
    `UPDATE documents SET content = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?`
  ).run(merged, new Date().toISOString(), user.id, doc.id);
  const updated = db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id);
  return { document: serializeDocument(db, updated, role) };
}

function config() {
  return { supportedImports: SUPPORTED_EXTENSIONS, maxUploadMb: LIMITS.uploadBytes / 1024 / 1024 };
}

// ------------------------------------------------------------------ router

// [method, pattern, handler, options]
const ROUTES = [
  ['GET', '/api/health', () => ({ ok: true }), { auth: false }],
  ['GET', '/api/config', config, { auth: false }],
  ['POST', '/api/login', login, { auth: false, json: true }],
  ['POST', '/api/logout', logout, { auth: false }],
  ['GET', '/api/me', me, { auth: false }],
  ['GET', '/api/users', listUsers],
  ['GET', '/api/documents', listDocuments],
  ['POST', '/api/documents', createDocument, { json: true }],
  ['POST', '/api/documents/import', importAsNew],
  ['GET', '/api/documents/:id', getDocument],
  ['PATCH', '/api/documents/:id', updateDocument, { json: true }],
  ['DELETE', '/api/documents/:id', deleteDocument],
  ['POST', '/api/documents/:id/import', importIntoExisting],
  ['POST', '/api/documents/:id/shares', addShare, { json: true }],
  ['DELETE', '/api/documents/:id/shares/:userId', removeShare],
].map(([method, pattern, handler, options = {}]) => {
  const keys = [];
  const regex = new RegExp(
    '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$'
  );
  return { method, regex, keys, handler, auth: options.auth !== false, json: !!options.json };
});

function matchRoute(method, pathname) {
  let pathMatched = false;
  for (const route of ROUTES) {
    const m = pathname.match(route.regex);
    if (!m) continue;
    pathMatched = true;
    if (route.method !== method) continue;
    const params = {};
    route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    return { route, params };
  }
  return { pathMatched };
}

// ------------------------------------------------------------ static files

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(pathname, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    rel = '/';
  }
  if (rel === '/favicon.ico') rel = '/favicon.svg';
  let file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) file = path.join(PUBLIC_DIR, 'index.html');
  if (rel === '/' || !path.extname(file)) file = path.join(PUBLIC_DIR, 'index.html'); // SPA fallback

  try {
    const data = await readFile(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

// --------------------------------------------------------------- app entry

export function createApp({ db, logger = console }) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { error: 'Method not allowed' });
      }
      return serveStatic(pathname, res);
    }

    try {
      const { route, params, pathMatched } = matchRoute(req.method, pathname);
      if (!route) {
        throw pathMatched ? new HttpError(405, 'Method not allowed') : new HttpError(404, 'Not found');
      }

      let user = null;
      if (route.auth) {
        user = userForToken(db, parseCookies(req.headers.cookie)[COOKIE_NAME]);
        if (!user) throw new HttpError(401, 'Please sign in');
      }
      const body = route.json ? await readJson(req) : {};
      const result = await route.handler({ db, req, res, params, user, body });
      if (!res.headersSent) sendJson(res, 200, result);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof HttpError) {
        return sendJson(res, err.status, { error: err.message, ...err.extra });
      }
      logger.error(err);
      sendJson(res, 500, { error: 'Something went wrong on our side' });
    }
  };
}
