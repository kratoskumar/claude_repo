# Working on the Making Charge Calculator

## What it is
- A static PWA. All app files live in `docs/` (no build step).
- Live address: **https://mcc.tarveengujral.com**.
- `.github/workflows/deploy.yml` deploys to Firebase Hosting (and publishes the security rules)
  when changes to `docs/`, `firebase/`, `firebase.json` or the workflow merge into `main`.
- `.github/workflows/monitor.yml` runs `scripts/monitor.mjs` hourly to check usage against the free limits,
  the certificate and domain expiry. It pushes changes to the owner's phone (ntfy) and pings healthchecks.io.
- The command center that runs outside Google is planned in `command-center/PLAN.md` (phases 1–4).

## The repository is public
- Logs, issues, pushes and commit messages must never carry names, emails or user IDs. Pass anything
  logged or sent from the monitor through `scrub()` in `scripts/monitor.mjs`. Alerts show counts only.
- The ntfy topic, healthchecks.io ping address and any tokens are GitHub secrets, never files in the repo.

## Versioning
- Every change to `docs/` must bump `VERSION` in **both** `docs/sw.js` and `docs/app.js`,
  to the same value. Otherwise installed phones keep the old cached copy.

## Config and secrets (`docs/config.js`)
- `FIREBASE.authDomain` must equal `CANONICAL_HOST`. Google sign-in breaks otherwise.
- `FORWARD_FROM` lists the old addresses that forward to `CANONICAL_HOST`.
- The values in `config.js` are public by design. Never put secrets in the repo: no service-account
  keys, tokens or passwords. The deploy key lives only in the GitHub secret `FIREBASE_SERVICE_ACCOUNT`.

## Security rules
- They live in `firebase/firestore.rules`.
- Leave the `PASTE-YOUR-UID-HERE` placeholder as it is. The deploy fills in the owner UID from
  `OWNER_UID` in `docs/config.js`, and it fails unless the placeholder appears exactly once.
- Any change to the rules needs matching tests in `tests/rules.test.mjs`.

## Tests
- Run `npm test` (all suites: unit, rules, monitor, components, e2e) before opening any pull request.
  All suites must pass.
- Add tests for new features in the suite that fits (see the README, "Development and tests").
- You need Node 20+, Java 21 for the Firebase emulator, and Playwright with Chromium.

## Stay on the Firebase free (Spark) plan
- Add no heavy libraries. The calculator should stay about 25 KB compressed.
- Keep photos small: they are shrunk on the phone to about 200 KB, with thumbnails of about 9 KB.
- Keep the cloud code lazy-loaded: `cloud.js` loads only on sign-in and `admin.js` only for the owner.
  Never import them at startup.
- Avoid changes that add many reads or writes. The limits are in the README, "Limits that keep it free".

## Workflow
- Work on a branch, never directly on `main`.
- Open a pull request, then **merge only after the owner confirms**.
