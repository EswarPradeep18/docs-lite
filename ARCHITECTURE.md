# Architecture note

## Goal for the timebox

Ship one coherent, trustworthy slice: **write → save → share → collaborate safely**. I put depth into the things that make a shared editor trustworthy (access control that can't be bypassed, never losing or silently overwriting someone's work, safe handling of untrusted HTML and files) and kept breadth small.

## Shape of the system

```
Browser (vanilla JS SPA)                 Node 22 (node:http)                 SQLite (node:sqlite)
┌───────────────────────────┐   JSON    ┌──────────────────────────────┐    ┌──────────────────┐
│ sign in · doc list ·      │ ───────▶ │ router → auth → permissions  │ ─▶ │ users            │
│ editor (contenteditable)  │           │ → validate → sanitize → SQL  │    │ sessions         │
│ autosave + version check  │ ◀─────── │ importers (.txt/.md/.docx)   │    │ documents        │
│ share dialog · import     │           │ static files                 │    │ shares           │
└───────────────────────────┘           └──────────────────────────────┘    └──────────────────┘
```

One process, one SQLite file, **zero third-party dependencies**. Reviewers run `npm start` with nothing to install, and there is no supply chain to audit.

## Key decisions

**1. One place for access rules.** `src/permissions.js` resolves the caller's role (`owner`, `editor`, `viewer`, or none) and every document route goes through it. Owners can share and delete; editors can edit, rename and import; viewers read. No access returns **404, not 403**, so someone can't confirm a document exists by guessing IDs (they are random UUIDs anyway). Role checks are enforced on the server; the UI only mirrors them.

**2. Never silently lose work: optimistic concurrency.** Each document has a `version`. A content save must send the `baseVersion` it was edited from, and the `UPDATE … WHERE version = ?` only applies if nobody saved in between. Otherwise the server returns 409 with the latest copy and the user chooses **Load their version** or **Keep mine**. Renames don't bump the version, so retitling never conflicts with typing. I chose this over real-time CRDT co-editing (Yjs etc.) because CRDTs need WebSockets, a presence layer and a different storage model. That is a multi-day feature to do properly, and a half-done version is worse than an honest conflict prompt.

**3. Lightweight collaboration signal.** Open editors poll every 8 seconds (paused when the tab is hidden). If someone else saved and you have no unsaved changes, the page updates in place and tells you who edited. If you are mid-edit, a banner offers to show the latest instead of yanking the text under your cursor.

**4. HTML as the storage format, sanitized on every write.** The editor's HTML is stored directly, which preserves formatting exactly and makes reopening trivial. Because shared documents are rendered in other people's browsers, every write goes through an **allowlist sanitizer** that keeps only formatting tags (`p`, `h1–h3`, `strong`, `em`, `u`, `s`, lists, `blockquote`, `pre`, `code`, `br`, `hr`) and drops all attributes. That removes scripts, event handlers, inline styles and links in one rule. The same module runs in the browser on paste, so what you see is what gets saved. CSP headers add a second layer.

**5. File import is real conversion, not attachment storage.** Uploads become editable documents, which is the more useful product behavior. `.md` uses a small converter that escapes HTML before adding formatting. `.docx` is parsed directly: a minimal zip reader (with a 20 MB inflate cap against zip bombs) extracts `word/document.xml` and `word/numbering.xml`, and paragraphs map to headings, bold/italic/underline runs, and bulleted vs numbered lists. Files can create a new doc or be appended into the open one (editors only). Uploads are size-limited (5 MB), type-checked by extension and content, and fail with readable messages.

**6. Lightweight auth that is still real.** Seeded demo accounts keep review friction low, but the mechanics are production-shaped: scrypt password hashes, random 256-bit session tokens in the database, HttpOnly + SameSite=Lax cookies (Secure behind HTTPS), 7-day expiry.

**7. Editor engine.** The editor uses `contenteditable` with the browser's formatting commands. It is a deprecated API, but it is supported in every current browser, needs no build step, and covers everything the brief asks for. The trade-off is a weaker document model than ProseMirror/TipTap (e.g. undo history doesn't survive reloads). The sanitizer and the server API are editor-agnostic, so swapping in TipTap later only touches `public/app.js`.

## What I cut and why

| Cut | Why |
|---|---|
| Real-time co-editing (CRDT/OT) | Large and easy to get subtly wrong; replaced with conflict detection + polling, which is honest and safe. |
| Comments, suggestions, version history | Valuable, but each is a feature in its own right. Version history is the cheapest next step because versions are already tracked. |
| Images, tables, fonts, colors | Expand the sanitizer and storage surface; not needed to show the core loop. |
| Sign-up, password reset, external share links | Seeded users satisfy the review need; a share-link model needs expiring tokens and abuse controls. |
| Postgres / managed services | SQLite keeps setup to zero. Data access is plain SQL in two files, so a move to Postgres is contained. |

## Testing strategy

Tests target the behavior most likely to break silently: the permission matrix, the 409 conflict path, sanitization, and import conversion. The API tests boot the real HTTP server on a random port against an in-memory database, so they exercise routing, auth cookies, validation and SQL together rather than mocks. The UI was verified with a scripted headless-Chrome run covering three users at once (see AI_WORKFLOW.md).
