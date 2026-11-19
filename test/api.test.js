// Integration tests against the real HTTP app + SQLite (in memory).
// These cover the parts most likely to break silently: access control,
// concurrent edits, persistence of formatting, and upload handling.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, signIn, makeDocx } from './helpers.js';

let server, alice, bob, carol;

before(async () => {
  server = await startTestServer();
  [alice, bob, carol] = await Promise.all(
    ['alice@demo.test', 'bob@demo.test', 'carol@demo.test'].map((e) => signIn(server.base, e))
  );
});
after(() => server.close());

test('unauthenticated requests are rejected', async () => {
  const res = await fetch(`${server.base}/api/documents`);
  assert.equal(res.status, 401);
});

test('wrong password is rejected with a clear message', async () => {
  const res = await fetch(`${server.base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'alice@demo.test', password: 'nope' }),
  });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /incorrect/i);
});

test('create, rename, edit and reopen a document with formatting preserved', async () => {
  const created = await alice.post('/api/documents', {});
  assert.equal(created.status, 201);
  const id = created.body.document.id;
  assert.equal(created.body.document.title, 'Untitled document');

  const renamed = await alice.patch(`/api/documents/${id}`, { title: '  Launch   plan ' });
  assert.equal(renamed.body.document.title, 'Launch plan');

  const html = '<h1>Launch</h1><p><strong>Bold</strong> <em>it</em> <u>under</u></p><ul><li>one</li></ul><ol><li>two</li></ol>';
  const saved = await alice.patch(`/api/documents/${id}`, { content: html, baseVersion: 1 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.document.version, 2);

  const reopened = await alice.get(`/api/documents/${id}`);
  assert.equal(reopened.body.document.content, html);
  assert.equal(reopened.body.document.title, 'Launch plan');
});

test('stored content is sanitized (no scripts, handlers or attributes)', async () => {
  const { body } = await alice.post('/api/documents', { title: 'XSS check' });
  const id = body.document.id;
  const res = await alice.patch(`/api/documents/${id}`, {
    content: '<p onclick="steal()">Hi<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:x">link</a></p>',
    baseVersion: 1,
  });
  const content = res.body.document.content;
  assert.equal(content, '<p>Hilink</p>');
});

test('validation: empty and overly long titles are rejected', async () => {
  const { body } = await alice.post('/api/documents', {});
  const id = body.document.id;
  assert.equal((await alice.patch(`/api/documents/${id}`, { title: '   ' })).status, 400);
  assert.equal((await alice.patch(`/api/documents/${id}`, { title: 'x'.repeat(201) })).status, 400);
  assert.equal((await alice.patch(`/api/documents/${id}`, { content: '<p>x</p>' })).status, 400); // missing baseVersion
});

test('sharing: non-shared users cannot see a doc; viewers read only; editors can edit', async () => {
  const { body } = await alice.post('/api/documents', { title: 'Roadmap' });
  const id = body.document.id;

  // Before sharing: invisible to Bob (404, not 403, so IDs can't be probed).
  assert.equal((await bob.get(`/api/documents/${id}`)).status, 404);

  // Share with Bob as viewer.
  const shared = await alice.post(`/api/documents/${id}/shares`, { email: 'BOB@demo.test', role: 'viewer' });
  assert.equal(shared.status, 200);
  assert.deepEqual(shared.body.shares.map((s) => [s.email, s.role]), [['bob@demo.test', 'viewer']]);

  const asViewer = await bob.get(`/api/documents/${id}`);
  assert.equal(asViewer.status, 200);
  assert.equal(asViewer.body.document.role, 'viewer');
  assert.equal(asViewer.body.document.shares, undefined); // only owners see the share list
  assert.equal((await bob.patch(`/api/documents/${id}`, { content: '<p>hack</p>', baseVersion: 1 })).status, 403);

  // Bob sees it under "Shared with me", not "My documents".
  const bobList = await bob.get('/api/documents');
  assert.ok(bobList.body.shared.some((d) => d.id === id && d.ownerName === 'Alice Chen'));
  assert.ok(!bobList.body.owned.some((d) => d.id === id));

  // Upgrade to editor; Bob can now edit, but still can't share or delete.
  await alice.post(`/api/documents/${id}/shares`, { email: 'bob@demo.test', role: 'editor' });
  const edit = await bob.patch(`/api/documents/${id}`, { content: '<p>Bob was here</p>', baseVersion: 1 });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.document.updatedBy, 'Bob Patel');
  assert.equal((await bob.post(`/api/documents/${id}/shares`, { email: 'carol@demo.test' })).status, 403);
  assert.equal((await bob.del(`/api/documents/${id}`)).status, 403);

  // Carol still has no access.
  assert.equal((await carol.get(`/api/documents/${id}`)).status, 404);

  // Revoke: Bob loses access immediately.
  const bobId = shared.body.shares[0].userId;
  await alice.del(`/api/documents/${id}/shares/${bobId}`);
  assert.equal((await bob.get(`/api/documents/${id}`)).status, 404);
});

test('sharing validation: unknown user, self-share and bad role', async () => {
  const { body } = await alice.post('/api/documents', {});
  const id = body.document.id;
  assert.equal((await alice.post(`/api/documents/${id}/shares`, { email: 'nobody@demo.test' })).status, 404);
  assert.equal((await alice.post(`/api/documents/${id}/shares`, { email: 'alice@demo.test' })).status, 400);
  assert.equal((await alice.post(`/api/documents/${id}/shares`, { email: 'bob@demo.test', role: 'admin' })).status, 400);
});

test('concurrent edits: a stale save gets 409 with the latest copy instead of overwriting', async () => {
  const { body } = await alice.post('/api/documents', { title: 'Shared notes' });
  const id = body.document.id;
  await alice.post(`/api/documents/${id}/shares`, { email: 'bob@demo.test', role: 'editor' });

  // Both opened version 1. Alice saves first.
  assert.equal((await alice.patch(`/api/documents/${id}`, { content: '<p>Alice</p>', baseVersion: 1 })).status, 200);
  const stale = await bob.patch(`/api/documents/${id}`, { content: '<p>Bob</p>', baseVersion: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.document.content, '<p>Alice</p>');
  assert.equal(stale.body.document.version, 2);

  // Bob chooses "keep mine" by rebasing on the version he was shown.
  const retry = await bob.patch(`/api/documents/${id}`, { content: '<p>Bob</p>', baseVersion: 2 });
  assert.equal(retry.status, 200);

  // Renames never conflict with content edits.
  assert.equal((await alice.patch(`/api/documents/${id}`, { title: 'Renamed' })).status, 200);
});

test('import: .docx becomes a new owned document with headings, formatting and lists', async () => {
  const res = await alice.post('/api/documents/import', makeDocx(), { 'X-Filename': encodeURIComponent('Q3 Plan.docx') });
  assert.equal(res.status, 201);
  const doc = res.body.document;
  assert.equal(doc.title, 'Q3 Plan');
  assert.equal(doc.role, 'owner');
  assert.equal(
    doc.content,
    [
      '<h1>Quarterly Plan</h1>',
      '<p>Ship the <strong>editor</strong> and <em><u>sharing</u></em> &amp; more &lt;soon&gt;</p>',
      '<ul><li>First bullet</li><li>Second bullet</li></ul>',
      '<ol><li>Step one</li></ol>',
    ].join('\n')
  );
});

test('import: markdown appends into an existing doc; unsupported and broken files are rejected', async () => {
  const { body } = await alice.post('/api/documents', {});
  const id = body.document.id;
  await alice.patch(`/api/documents/${id}`, { content: '<p>Intro</p>', baseVersion: 1 });

  const md = Buffer.from('## Notes\n\n- **one**\n- two');
  const res = await alice.post(`/api/documents/${id}/import`, md, { 'X-Filename': 'notes.md' });
  assert.equal(res.status, 200);
  assert.equal(res.body.document.content, '<p>Intro</p>\n<h2>Notes</h2>\n<ul><li><strong>one</strong></li><li>two</li></ul>');
  assert.equal(res.body.document.version, 3);

  // Viewers can't import into a doc.
  await alice.post(`/api/documents/${id}/shares`, { email: 'carol@demo.test', role: 'viewer' });
  assert.equal((await carol.post(`/api/documents/${id}/import`, md, { 'X-Filename': 'notes.md' })).status, 403);

  const pdf = await alice.post('/api/documents/import', Buffer.from('%PDF'), { 'X-Filename': 'scan.pdf' });
  assert.equal(pdf.status, 422);
  assert.match(pdf.body.error, /unsupported file type/i);

  const broken = await alice.post('/api/documents/import', Buffer.from('not a zip'), { 'X-Filename': 'x.docx' });
  assert.equal(broken.status, 422);
  assert.match(broken.body.error, /could not be read/i);
});

test('owner can delete; the doc disappears for collaborators too', async () => {
  const { body } = await alice.post('/api/documents', {});
  const id = body.document.id;
  await alice.post(`/api/documents/${id}/shares`, { email: 'bob@demo.test', role: 'editor' });
  assert.equal((await alice.del(`/api/documents/${id}`)).status, 200);
  assert.equal((await bob.get(`/api/documents/${id}`)).status, 404);
  assert.ok(!(await bob.get('/api/documents')).body.shared.some((d) => d.id === id));
});

test('seeded welcome doc demonstrates owner / editor / viewer out of the box', async () => {
  const welcome = (await alice.get('/api/documents')).body.owned.find((d) => d.title === 'Welcome to Docs Lite');
  assert.ok(welcome);
  assert.equal((await bob.get(`/api/documents/${welcome.id}`)).body.document.role, 'editor');
  assert.equal((await carol.get(`/api/documents/${welcome.id}`)).body.document.role, 'viewer');
});
