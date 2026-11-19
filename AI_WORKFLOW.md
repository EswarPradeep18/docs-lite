# AI workflow note

> **Before submitting:** edit this note so every line matches what you actually did. Reviewers will ask about it in the walkthrough.

## Tools used

- **Claude (Anthropic)** as a pair programmer: scoping, generating most of the first-draft code, tests and docs, and running a scripted headless-Chrome check of the UI.
- **Node's built-in test runner** and **Playwright + headless Chrome** to verify the output.

## Where AI materially sped things up

- **Scoping in minutes instead of an hour.** Turning the open-ended brief into a plan: which features get depth (access control, conflict handling, sanitization, real .docx conversion) and which get cut (CRDT co-editing, comments, history).
- **Boilerplate-heavy parts.** The router, SQL schema, share dialog, CSS, and especially the .docx reader. Writing a zip parser and the WordprocessingML mapping (runs, styles, numbering definitions) by hand would have taken most of the timebox.
- **Test scaffolding.** The in-memory server harness and a helper that builds a real .docx in memory, so import is tested against an actual zip file, not a mock.

## What I changed or rejected

- **Rejected a Next.js + Prisma + TipTap stack** in favor of zero dependencies. Package installs weren't available in the build environment, and I preferred code I could actually run and test over code I'd have to trust blindly. It also gives reviewers a no-install setup.
- **Rejected a client-only sanitizer.** Sanitizing only in the browser is bypassable with a direct API call. Sanitization runs on the server on every write; the browser copy is only for paste UX.
- **Changed "no access → 403" to 404** so document IDs can't be probed.
- **Changed renames to not bump the document version**, after noticing that a rename would have caused a false edit conflict for a collaborator who was typing.
- **Fixed bugs that the headless-browser run caught**, which the generated code had shipped with:
  1. An empty yellow banner showed on every document: the `.banner { display: flex }` rule overrode the HTML `hidden` attribute. Fixed with a global `[hidden] { display: none !important }`.
  2. Pasting in Chrome re-added inline `style="font-size…"` to pasted text even after sanitizing, because `insertHTML` copies computed styles. The server stripped it on save, but the editor briefly showed something different from what was stored. Fixed by cleaning the editor DOM after paste.
  3. The `npm test` script pointed `node --test` at a directory, which Node 22 treats as a module path. Changed to a glob.
  4. A "not signed in" check logged a 401 error in the console on every first visit; `/api/me` now returns `{ user: null }` instead.

## How I verified correctness, UX and reliability

- **Automated tests (16, all passing):** permission matrix including revoke, 409 conflict + rebase, XSS payloads in stored content, validation errors, .docx/.md import, corrupt and unsupported uploads.
- **Scripted three-user browser run** in headless Chrome: Alice creates and formats a doc → reload confirms title and formatting persisted → shares with Bob (editor) and Carol (viewer) → sharing with an unknown email shows an inline error → Bob sees it under "Shared with me" and edits → Alice's idle page picks up Bob's edit → Carol gets a read-only page → .md import creates a formatted doc → malicious paste is sanitized → simultaneous edits by Alice and Bob trigger the conflict banner and "Keep mine" saves → mobile layout check. Console errors were checked on every step.
- **Screenshots of every screen** reviewed by eye for layout and copy (in `docs/screenshots/`).
- **Manual review** of the security-relevant code: sanitizer, permissions, cookie flags, upload limits.
