# Docs Lite

A lightweight collaborative document editor inspired by Google Docs. Create and format documents, import files, and share them with teammates as editors or viewers.

**Live demo:** https://docs-lite-mj8o.onrender.com
**Walkthrough video:** see [`VIDEO_URL.txt`](VIDEO_URL.txt)

![Editor](docs/screenshots/03-editor.png)

## Demo accounts

All accounts use the password **`demo1234`**. The sign-in page also has one-click buttons for each.

| Account | Email | Role on the seeded "Welcome to Docs Lite" doc |
|---|---|---|
| Alice Chen | `alice@demo.test` | Owner |
| Bob Patel | `bob@demo.test` | Editor |
| Carol Diaz | `carol@demo.test` | Viewer |

**Fastest way to review sharing:** open the app in two browser windows (or one normal and one private window), sign in as Alice in one and Bob in the other, and open the welcome doc in both. Edits by one person appear for the other within about 8 seconds. Sign in as Carol to see the read-only view.

## What works

| Area | Details |
|---|---|
| Documents | Create, rename (click the title), edit, delete (owner only), reopen. List split into **My documents** and **Shared with me**. |
| Rich text | Normal text / Heading 1–3, **bold**, *italic*, <u>underline</u>, strikethrough, bulleted and numbered lists, clear formatting. Keyboard shortcuts Ctrl/Cmd+B/I/U, Ctrl/Cmd+S to save now. |
| Saving | Autosave about 0.8s after you stop typing, with a visible status ("Saving…", "All changes saved", "Couldn't save. Retrying…"). Warns before closing the tab with unsaved changes. |
| File upload | Import **.txt, .md, .docx** (max 5 MB) as a **new document** from the home page, or **append into the open document** from the editor toolbar. Headings, bold/italic/underline and lists are kept from .md and .docx. Other types get a clear error. Sample files are in [`samples/`](samples). |
| Sharing | The owner shares by email as **Can edit** or **Can view**, changes roles, or removes access. Viewers get a read-only page. People without access get a 404, so document IDs can't be probed. |
| Concurrent edits | Optimistic versioning: if someone saved since you loaded, your save is rejected (409) and you choose **Load their version** or **Keep mine**. Nothing is silently overwritten. Idle editors and viewers pick up others' changes automatically. |
| Safety | All stored HTML goes through an allowlist sanitizer (no scripts, attributes, styles or links). Pasted content goes through the same sanitizer. Passwords hashed with scrypt; HttpOnly SameSite session cookies; CSP headers. |

## Run locally

Requirements: **Node.js 22.13 or newer**. There are **no dependencies to install** (it uses Node's built-in HTTP server, SQLite and test runner).

```bash
npm start          # http://localhost:3000
npm test           # 16 tests: API integration + unit
npm run dev        # restarts on file changes
```

Configuration (environment variables):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_FILE` | `./data/docs-lite.db` | SQLite database file (created automatically) |

The database is created and seeded on first start. To reset, stop the server and delete the `data/` folder.

## Deployment

**Render (free, what the live demo uses):** push this folder to a GitHub repo, then in Render choose **New → Blueprint** and select the repo. `render.yaml` configures everything (no build step, `npm start`, health check at `/api/health`).

Trade-off to know about: Render's free plan has an ephemeral disk. Documents persist across page refreshes and while the instance is running, but are reset when Render redeploys or spins the free instance down after inactivity (first request after idle takes ~30–50s). Demo users and the welcome doc are re-seeded on every boot, so the review flow always works.

**Durable alternative:** the included `Dockerfile` runs on any container host. Mount a volume at `/data` (e.g. a Fly.io volume) and data survives deploys. Moving to Postgres would only touch `src/db.js` and the SQL in `src/app.js`.

## Tests

```bash
npm test
```

- `test/api.test.js` boots the real server against an in-memory database and checks: auth, create/rename/edit/reopen with formatting preserved, sanitization of stored HTML, input validation, the full owner/editor/viewer/no-access matrix including revoking access, the 409 edit-conflict flow, .docx and .md import (new doc and append), rejection of unsupported/corrupt files, and delete cascading to collaborators.
- `test/unit.test.js` covers the sanitizer, the Markdown and plain-text converters, and file validation.

The UI was also checked end to end in headless Chrome with three simultaneous users (see [AI_WORKFLOW.md](AI_WORKFLOW.md)).

## Project layout

```
server.js                 entry point: open DB, seed, start HTTP server
src/app.js                router, validation, all API handlers, static files
src/permissions.js        the single place access rules live
src/db.js                 schema + demo seed
src/auth.js               password hashing, sessions, cookies
src/importers.js          .txt / .md / .docx → sanitized HTML
src/zip.js                minimal zip reader for .docx
public/                   front end (vanilla JS, no build step)
public/shared/sanitize.js HTML sanitizer used by both server and browser
test/                     node:test suites
samples/                  files to try the import with
docs/screenshots/         screenshots of each flow
```

## API

All endpoints are JSON and require a session cookie except sign-in, `/api/me`, `/api/config` and `/api/health`.

| Method | Path | Who |
|---|---|---|
| POST | `/api/login`, `/api/logout` | anyone |
| GET | `/api/documents` | signed in → `{ owned, shared }` |
| POST | `/api/documents` | signed in |
| POST | `/api/documents/import` | signed in (raw file body, `X-Filename` header) |
| GET | `/api/documents/:id` | owner, editor, viewer |
| PATCH | `/api/documents/:id` | owner, editor (`title` and/or `content` + `baseVersion`) |
| DELETE | `/api/documents/:id` | owner |
| POST | `/api/documents/:id/import` | owner, editor |
| POST / DELETE | `/api/documents/:id/shares[/:userId]` | owner |

## Status: working, incomplete, next

**Working end to end:** everything in "What works" above, locally and deployed.

**Deliberately not built:** real-time character-level co-editing (CRDT/OT), comments and suggestions, version history, export, images and tables, real sign-up / password reset, share links for people outside the workspace. Reasons are in [ARCHITECTURE.md](ARCHITECTURE.md).

**Known limitations:**
- Editing uses the browser's built-in `contenteditable` commands. They work well in Chrome, Edge, Firefox and Safari but are a deprecated API; see the architecture note for the planned replacement.
- .docx import keeps text structure, not layout: tables become paragraphs; images, fonts, colors and nested list levels are dropped.
- Free-tier hosting resets data on redeploy (see Deployment).

**Next 2–4 hours:**
1. Swap the editor core to TipTap/ProseMirror for a structured document model and reliable undo across saves.
2. Version history: store a snapshot per save in a `revisions` table, add a "restore" view. The versioning column already exists.
3. Presence: "Bob is viewing" avatars using the existing polling endpoint, then move to Server-Sent Events.
4. Export to Markdown/PDF (reverse of the existing Markdown importer).
