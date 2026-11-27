# Making Charge Calculator

A light, phone-friendly web app that works out the **making charge** on gold jewellery from its price and
gold weight, in **USD or INR**, with the **US or India gold rate** for **today or any day in the last 3 years**.
Approved friends and family can sign in (Google or email), save calculations with a product link and photo,
and see them on all their devices. The owner gets a private dashboard and alerts.

- **Free**: Firebase's free Spark plan (hosting, login, database) plus GitHub (code, deploys, alerts). No AI or Claude at run time.
- **Fast**: the calculator is about 25 KB compressed, opens instantly and works offline after the first visit.
  The cloud code loads only when someone signs in. The dashboard code loads only for the owner.
- **Installable**: "Add to Home Screen" on iPhone or Android.

Main address: **https://mcc.tarveengujral.com**. The older addresses (`making-charge.web.app`, `making-charge.firebaseapp.com`
and the GitHub Pages link) forward there, keeping `#saved` and `#admin`.

## How the numbers are worked out

| Step | Formula |
| --- | --- |
| Price before tax | price ÷ (1 + tax %), only if "Price includes GST / sales tax" is ticked |
| Gold value | weight (g) × 24K rate per gram × purity |
| **Making charge** | price before tax − stones/other charges − gold value |
| Making % | making charge ÷ gold value × 100 |
| Making per gram | making charge ÷ weight |

- **US rate**: the live international spot price (USD per troy ounce; 1 oz = 31.1034768 g).
- **India rate (estimate)**: international price × USD-INR × (1 + Indian import duty). GST is not included.
  Duty by date: 15% before 24 Jul 2024, 6% from 24 Jul 2024, 15% from 13 May 2026. This is editable in ⚙ Settings.
  Jewellers' board rates can differ by a few percent; type theirs over the estimate.
- **Purity** is a fraction of the 24K rate.
  India uses BIS fineness: 22K = 91.6%, 18K = 75%, 14K = 58.5%, 9K = 37.5%.
  The US uses karat ÷ 24: 22K = 91.67%, 14K = 58.33%, 10K = 41.67%. Custom % is also available.
- **Rates**: gold-api.com for the live price, plus the currency-api daily feed for gold and USD-INR from 2 Mar 2024 onward.
  Frankfurter (ECB) is the USD-INR fallback. Dates before 2 Mar 2024 ask you to type the gold rate.

## Who can use what

| | Calculator | Saved items | Admin dashboard |
| --- | --- | --- | --- |
| Anyone with the link | ✔ | | |
| Signed in, waiting for approval | ✔ | asks for access | |
| Approved member | ✔ | their own items only | |
| Owner | ✔ | their own items only | ✔ |

- Sign in with **Google** (one tap), or with **email + password** (with "Forgot password?").
  Sign in with Apple is not offered: it needs a paid Apple Developer membership ($99/year).
- New people tap **Request access**. The owner approves or declines in **Admin** and also gets a GitHub alert.
  Approval reaches the person's phone within seconds, without a reload.
- Each person's items, photos and settings (market, currency, purity, tax and duty table) are private to them
  and follow them across devices. The owner sees only how many items each person has, not the items themselves.

## Limits that keep it free

Firebase Spark plan, official free limits:

| Limit | Amount |
| --- | --- |
| Stored data | 1 GiB |
| Reads | 50,000/day |
| Writes | 20,000/day |
| Deletes | 20,000/day |
| Downloads | 10 GiB/month |
| Sign-ins | 3,000 active users/day |
| Hosting | 10 GB storage, 360 MB/day transfer |

Daily limits reset at midnight Pacific time.

Built-in constraints (the owner can change the first two in Admin → Limits):

- **Up to 25 people** with access.
- **Up to 100 saved items per person**. The database itself enforces this, so it cannot be bypassed.
- **Photos are shrunk on the phone** to about 200 KB, with list thumbnails of about 9 KB.

With these, 25 active people fit comfortably. Downloads (viewing many photos) are the first limit to watch.

## Owner dashboard and alerts

- **Admin tab** (owner only):
  - status and open alerts;
  - today's reads, writes and deletes against the free limits (exact numbers from Google when available, otherwise the app's estimate);
  - storage and this month's downloads;
  - people with access, active today and in the last 30 minutes;
  - today's problems (failed saves, "free limit reached", gold-rate source failures, other errors);
  - access requests to approve or decline;
  - members, with their item counts, last-seen time, and a Remove button that can also delete their data;
  - limits.
- **Hourly monitor** (`.github/workflows/monitor.yml`):
  - checks everything above, plus the app's address from outside (does it answer over HTTPS, is the certificate valid, when do the certificate and the domain expire);
  - sends a **phone push** through [ntfy](https://ntfy.sh) when an alert appears, gets worse or clears (never for unchanged alerts);
  - opens a **GitHub issue** that mentions the owner, so it arrives as a GitHub app notification and an email;
  - comments again only when an alert gets worse, and closes the issue when it clears;
  - pings a **dead-man's switch** at [healthchecks.io](https://healthchecks.io) after every run. If the pings stop (GitHub down, schedule paused, a broken secret), healthchecks.io alerts the owner. The monitor itself can't do that.
- **What it watches for:**
  - 70% (warning) and 90% (urgent) of any daily or monthly limit;
  - downloads on pace to run out;
  - any "free limit reached" error;
  - failed saves, rate-source failures and other errors;
  - 90% of member places used;
  - new access requests;
  - many people active at once;
  - members at their item limit;
  - the app not answering over HTTPS (twice in a row), or a certificate problem;
  - the certificate expiring within 14 days (urgent at 5), or the domain within 30 days (urgent at 7);
  - the monitor itself failing.
- **Not watched:** Hosting's 360 MB/day transfer. Google reports it only with billing turned on. The app is about 25 KB compressed, so it would take thousands of fresh visits a day to reach it.
- **The repository is public**, so the monitor's logs, issues and pushes carry counts only: no names, emails or user IDs.
- The monitor makes a tiny commit only if the repo has had no activity for 40 days. GitHub pauses scheduled jobs after 60 inactive days.

### Phone push and dead-man's switch (one-time setup)

Both are optional. The monitor skips each one until its secret exists. Add the secrets under
GitHub → Settings → Secrets and variables → Actions:

| Secret | What it is |
| --- | --- |
| `NTFY_TOPIC` | A long random topic name, for example 32 letters and digits. Anyone who knows it can read and send pushes on it, so keep it only here and in the ntfy app. |
| `NTFY_TOKEN` | Optional: an ntfy access token, if you later reserve the topic with an ntfy account. |
| `HEALTHCHECK_URL` | The ping address of a healthchecks.io check (`https://hc-ping.com/…`), with period 1 hour and grace 1 hour. |

1. Install the ntfy app (iPhone or Android) and subscribe to the topic on `ntfy.sh`.
2. Create a free healthchecks.io account and a check with period 1 hour and grace 1 hour. Under Integrations, add email and ntfy (same topic), so a silent monitor reaches the phone too.
3. Run **Actions → Monitor → Run workflow** once. You should see the check turn green on healthchecks.io.

Pushes carry only status and counts. They are not end-to-end encrypted, and the alerts never include names.

## One-time setup

The app needs these pieces once:
- a Firebase project (`making-charge`) with Email/Password and Google sign-in turned on;
- a Firestore database (Standard edition, production mode);
- Hosting enabled;
- a web app registered, with its values in [`docs/config.js`](docs/config.js), including `OWNER_UID`;
- a service-account key stored as the GitHub secret `FIREBASE_SERVICE_ACCOUNT`, with the roles Firebase Admin, Service Usage Consumer and Monitoring Viewer;
- `https://making-charge.web.app/__/auth/handler` added as an authorized redirect URI on the OAuth "Web client" in Google Cloud console.

Claude walks through these step by step. Keep **Authentication → Settings → User actions → Enable create (sign-up)** switched **on**,
because new Google and email users need it; the approval step controls access instead.

After that, every change merged into `main` deploys automatically through `.github/workflows/deploy.yml`, which also
publishes the security rules with the owner's UID filled in.

## Changing the app's address

The address lives in [`docs/config.js`](docs/config.js): `authDomain` and `CANONICAL_HOST` must be the same, and
`FORWARD_FROM` lists the addresses that forward to it. Google sign-in only works when `authDomain` is the address
the app is opened at, which is why both are set together.

**To switch back to `making-charge.web.app`** (for example before removing the custom domain):

1. In `docs/config.js` set:
   - `authDomain: 'making-charge.web.app'`
   - `CANONICAL_HOST = 'making-charge.web.app'`
   - `FORWARD_FROM = ['mcc.tarveengujral.com', 'making-charge.firebaseapp.com', 'kratoskumar.github.io']`

   Keep the custom domain in that list only while it is still connected. Delete it from the list once the domain is removed.
2. Bump `VERSION` in `docs/sw.js` and `docs/app.js`, run the tests, and merge into `main`. The deploy is automatic.
3. Wait until the live site shows the new version.
4. Only then remove the custom domain in Firebase → Hosting.

Keep the `making-charge.web.app` entries in Google Cloud → Credentials → Web client: the JavaScript origin and the
`/__/auth/handler` redirect URI. People sign in once more on the restored address and re-add the home-screen icon from it.
Saved items are unaffected, because they live in the cloud, not at an address.

## Maintenance

- After changing files in `docs/`, bump `VERSION` in both `docs/sw.js` and `docs/app.js` so phones update.
- If India changes its gold import duty, update it in ⚙ Settings (it syncs per person) and `DEFAULT_DUTY` in `docs/calc.js`.

## Development and tests

Requires Node 20+, Java 21 (Firebase emulator) and Playwright with Chromium.

```bash
npm install
npm run test:unit        # calculations, number parsing, rates (live + failures), monitor alert rules, push, certificate check
npm run test:rules       # database security rules (owner, members, requests, item cap, privacy)
npm run test:monitor     # hourly monitor against the emulator with fake Google/GitHub/ntfy/healthchecks services
npm run test:components  # photo shrinking, cloud saving, approval flow, dashboard in a real browser
npm run test:e2e         # 35 end-to-end steps on phone screens, including Google sign-in (emulator)
npm run serve            # local copy at http://127.0.0.1:8000/claude_repo/
```
