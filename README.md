# Kachow — web front-end (PWA)

The web layer for **Kachow**, a self-hosted, bilingual personal AI assistant. This repo
is the installable PWA and the thin HTTP endpoints; the domain logic, data layer and
Gemini tool-calling live in the companion repo
[`kachow-app`](https://github.com/christianmorkeberg/kachow-app) — start there for the
architecture, features and screenshots.

## What's in here

- **`index.php`** — the app shell (chat UI, top-bar menu, installable PWA).
- **`assets/app.js`** — the front-end: the chat loop, and the interactive **cards**
  (workout checklist, editable receipt, animated weather, menstrual-cycle ring, email
  reader, and hand-rolled inline-SVG charts — workout progression and work-hours — with
  tap-to-inspect points) rendered from the typed payloads the assistant returns.
- **`assets/styles.css`** — a single hand-written stylesheet (dark theme, animations,
  `prefers-reduced-motion` aware).
- **`api/*.php`** — small authenticated JSON endpoints (`chat.php`, `receipt.php`,
  `cycle.php`, OAuth callbacks, …). Each boots the app, checks the session, and calls
  into `kachow-app`.
- **`error.php`** — playful, racing-themed animated HTTP error pages.

## How it fits together

`bootstrap.php` autoloads `kachow-app` and loads its `.env`, so this repo has no
business logic or database code of its own — it authenticates the request, calls a
`kachow-app` class, and returns JSON (or renders a card). Configuration and setup are
documented in [`kachow-app`](https://github.com/christianmorkeberg/kachow-app).

## Stack

Vanilla JS (no framework) · installable PWA + service worker · Web Push · PHP endpoints ·
a strict-CSP sandboxed iframe for safe HTML-email rendering.

---

Built by [Christian Mørkeberg](https://github.com/christianmorkeberg) as a personal project.
