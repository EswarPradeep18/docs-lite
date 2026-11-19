# Submission: Docs Lite

**Candidate:** Eswar Pradeep Kunchala
**Live product URL:** `<LIVE_URL>`
**Walkthrough video:** see `VIDEO_URL.txt`

## Test accounts (password `demo1234` for all)

- `alice@demo.test`: owns the seeded "Welcome to Docs Lite" doc
- `bob@demo.test`: editor on that doc
- `carol@demo.test`: viewer on that doc

The sign-in page has one-click buttons for each. Use two browser windows (one private) to see sharing and live updates between users.

## What's included

| Item | Location |
|---|---|
| Source code | `server.js`, `src/`, `public/` |
| Automated tests (16) | `test/` (run with `npm test`) |
| README with local setup, run instructions, status and next steps | `README.md` |
| Architecture note | `ARCHITECTURE.md` |
| AI workflow note | `AI_WORKFLOW.md` |
| This file | `SUBMISSION.md` |
| Walkthrough video URL | `VIDEO_URL.txt` |
| Screenshots of every flow | `docs/screenshots/` |
| Sample files for testing upload (.docx, .md, .txt) | `samples/` |
| Deployment config | `render.yaml` (Render Blueprint), `Dockerfile` (any container host) |

## Status at a glance

- **Working end to end:** create, rename, rich-text editing, autosave, reopen; import .txt/.md/.docx as a new doc or into an existing one; sharing with owner/editor/viewer roles; edit-conflict protection; persistence in SQLite.
- **Incomplete / deliberately cut:** real-time co-editing, comments, version history, export, images/tables. Details and reasons in `ARCHITECTURE.md`.
- **Next 2–4 hours:** TipTap editor core, version history, presence indicators, Markdown/PDF export (see README).

## Local run

```bash
# Node.js 22.13+; nothing to install
npm start   # http://localhost:3000
npm test
```
