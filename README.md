# DeployGate

**Kane CLI Hackathon entry (TestMu AI) — "the app refuses to deploy until Kane CLI approves."**

DeployGate is a launch board for releases. A release has a checklist; items can be
added, checked/unchecked, and deleted. The **Deploy** button stays disabled until
every checklist item is checked — and even then, a real deploy only happens after
**Kane CLI** verifies the app end-to-end in a browser and passes. If Kane fails,
the deploy is blocked and a `kane-report.md` is written instead.

## Concept

Agents write code fast but can't check their own work. DeployGate closes that loop
in the most literal way possible: the deploy path itself is gated by an independent
AI verifier.

- **Ships** — a real app with a real flow (create release → checklist → deploy),
  not a slide deck.
- **Verified** — Kane CLI drives a real browser through the UI and proves the
  gate logic (including that Deploy is *disabled* until the checklist is green).
- **Closed loop** — a Kane failure blocks the deploy, writes a report, and the
  fix is verified by re-running the same gate (`npm run gate`).

## Architecture

```
deploy-gate/
├── server.js            # Demo app: Node built-in http, zero dependencies.
│                        # Serves public/ + a JSON API (/api/state, /api/releases…).
│                        # The deploy rule is enforced server-side too (409 if
│                        # checklist incomplete), so the gate is real on both sides.
├── public/
│   ├── index.html       # Launch board UI (data-testid hooks for Kane).
│   ├── app.js           # Frontend: fetch + DOM, no framework.
│   └── style.css
├── gate/
│   └── deploy.js        # The deploy gate CLI (npm run gate).
├── tests/
│   ├── happy-path.testmd    # Full flow: create → add → check → deploy.
│   ├── checklist-bug.testmd # Catches a real regression: checked items must
│   │                        # move from Pending to Completed (and back).
│   └── deploy-flow.testmd   # The gate itself: Deploy disabled until 2/2
│                            # checked; default objective for `npm run gate`.
├── package.json
└── .gitignore
```

State is kept in `data.json` (gitignored). The gate resets it before each run so
every Kane run starts from a deterministic, empty board.

## Run the app

```bash
npm start            # http://localhost:3000
```

Open the page, create a release, add checklist items, check them off — checked
items move to **Completed** — and press **Deploy** once everything is green.

## Run the gate

```bash
npm run gate                                   # default: tests/deploy-flow.testmd
node gate/deploy.js --objective tests/happy-path.testmd
node gate/deploy.js --objective tests/checklist-bug.testmd --port 4173
```

What the gate does:

1. Pre-checks `kane-cli whoami`. **If Kane CLI is not logged in, the gate fails
   closed** with a clear "Kane CLI belum login" message and exit code 2.
   It never fakes a pass.
2. Starts the app on localhost (default port 4173) with a fresh board.
3. Runs `kane-cli run "<objective>" --headless --agent` against the app.
4. Reads the NDJSON verdict + Kane exit code (0 = pass, 1 = fail, 2 = error,
   3 = timeout). PASS requires exit code 0 **and** no NDJSON verdict of
   "failed" — when in doubt, the deploy is blocked.
5. **PASS** → the app is copied to `dist/` and `deploy-record.json` is written
   (timestamp, verdict, objective, Kane exit code, evidence link).
   **FAIL / ERROR / TIMEOUT** → deploy blocked, `kane-report.md` written with
   a failure summary and the evidence path, non-zero exit.

## Closed loop (how Kane results feed back)

```
build → npm run gate → Kane runs the objective in a real browser
        ├── PASS  → dist/ + deploy-record.json (evidence link inside)
        └── FAIL  → kane-report.md → fix the app → npm run gate again
```

Every re-run uses the same objectives, so a fix is proven by the same test
that caught the bug — that is the loop the judges score.

## Status — honest note

- ✅ App works end-to-end locally (API + UI verified with curl, see below).
- ✅ Gate fails closed correctly when Kane CLI is not logged in (verified:
  prints "Kane CLI belum login", writes `kane-report.md`, exits 2).
- ✅ **A real Kane run PASSED on 19 Nov 2026** — `npm run gate` drove a real
  browser through the full deploy flow (19 steps, 159 s): release "Gate
  check — v2.0.0" created, Deploy disabled at 0/2 and 1/2 items checked,
  enabled at 2/2 with status "Ready to deploy", clicked Deploy → status
  "Deployed" with a timestamp. Kane exit code 0, verdict "passed",
  evidence uploaded to Test Manager. Nothing in this repo simulates or
  stubs a Kane pass.

## Local verification (no Kane needed)

```bash
# Start the app
PORT=3000 npm start &
# Create a release, add items, check them, deploy:
curl -s -X POST localhost:3000/api/releases -H 'Content-Type: application/json' \
  -d '{"name":"v1.4.0"}'
# (take the id from the response)
curl -s -X POST localhost:3000/api/releases/<id>/items -H 'Content-Type: application/json' \
  -d '{"text":"Run unit tests"}'
curl -s -X PATCH localhost:3000/api/releases/<id>/items/<itemId> \
  -H 'Content-Type: application/json' -d '{"done":true}'
# Deploy before all items are checked -> 409 "cannot deploy"
# Deploy after all checked -> 200, status "Deployed"
curl -s -X POST localhost:3000/api/releases/<id>/deploy

# Gate without Kane login -> fails closed:
npm run gate   # expect: "Kane CLI belum login", exit code 2, kane-report.md written
```

## Hackathon checklist

- [x] Repo initialised on/after 12 Nov 2026 (created 19 Nov 2026)
- [x] App runs end-to-end
- [x] Kane CLI objectives written (3 testmd files)
- [x] Closed loop designed (fail → report → fix → re-run)
- [x] `kane-cli login` (basic auth, 19 Nov 2026; balance 11.200 credits)
- [x] Real Kane run passes (`npm run gate` → `dist/` + `deploy-record.json`) — PASSED 19 Nov 2026, 19 steps, 159 s, evidence on Test Manager
- [ ] Demo video (3–5 min, YouTube)
- [ ] 2+ public posts (X / Reddit / LinkedIn / Hacker News)
- [ ] Submit before 27 Nov 2026 01:29 WIB
