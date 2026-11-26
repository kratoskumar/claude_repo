# Making Charge Calculator

A light, phone-friendly web app for working out the **making charge** on a piece of gold jewellery
from its price and gold weight, in **USD or INR**, using the **US or India gold rate** for **today or any
day in the last 3 years**. Calculations can be saved with a product link and a photo, and are shared
between phones through one family login.

- Free to run and free to use: hosted on GitHub Pages, data on Firebase's free plan. No Claude login and no AI at run time.
- Fast: the calculator is about 22 KB (compressed) and opens instantly and offline after the first visit.
- Installable: "Add to Home Screen" on iPhone or Android and it opens like an app.

App address (once GitHub Pages is switched on, see step 3): **https://kratoskumar.github.io/claude_repo/**

## How the numbers are worked out

| Step | Formula |
| --- | --- |
| Price before tax | price ÷ (1 + tax %), only if "Price includes GST / sales tax" is ticked |
| Gold value | weight (g) × 24K rate per gram × purity |
| **Making charge** | price before tax − stones/other charges − gold value |
| Making % | making charge ÷ gold value × 100 |
| Making per gram | making charge ÷ weight |

- **US rate** = live international spot price (USD per troy ounce, 1 oz = 31.1034768 g).
- **India rate (estimate)** = international price × USD-INR × (1 + Indian import duty). GST is not included.
  Duty used by date: 15% before 24 Jul 2024, 6% from 24 Jul 2024, 15% from 13 May 2026.
  You can change this in Settings if the duty changes again.
  A jeweller's board rate can differ by a few percent, so you can always type their rate over the estimate.
- **Purity** (fraction of the 24K rate): India uses BIS hallmark values (22K = 91.6%, 18K = 75%, 14K = 58.5%,
  9K = 37.5%); the US uses karat ÷ 24 (22K = 91.67%, 14K = 58.33%, 10K = 41.67%). Custom % is also available.
- **GST** (India, default 3%) and **sales tax** (US, default off) are applied to the whole bill when ticked.
- Prices are converted between USD and INR at the rate for the chosen date (today = latest rate). You can type your own rate.

### Where the rates come from

| What | Source | Notes |
| --- | --- | --- |
| Today's gold | gold-api.com | live spot price, refreshed every 10 minutes |
| Past days' gold and USD-INR | currency-api daily reference rates (via jsDelivr, mirror on pages.dev) | available from **2 Mar 2024**; for the 2 days missing from the feed, the previous day is used and the app says so |
| USD-INR fallback | Frankfurter (European Central Bank rates) | used if the feed has no rate |

For dates before 2 Mar 2024 (until that falls out of the 3-year window in March 2027), the app asks you to type the gold rate.
Past rates are remembered on the phone, so each day is only downloaded once.

## One-time setup (about 15 minutes)

### 1. Create the free Firebase project (stores the saved items and the login)

1. Go to <https://console.firebase.google.com>, sign in with a Google account, click **Create a project**,
   give it a name (for example `making-charge`). Google Analytics is not needed: switch it off. Stay on the free **Spark** plan.
2. **Login:** open **Build → Authentication → Get started**. Under **Sign-in method**, choose **Email/Password**,
   switch on the first toggle, **Save**.
3. **The one account:** go to the **Users** tab → **Add user**. Enter the email and a strong password you and your
   wife will both use. Then copy the **User UID** shown in the list (a long code like `Xy12...`).
4. (Recommended) **Block new sign-ups:** **Authentication → Settings → User actions**, untick
   **Enable create (sign-up)**, **Save**. If you don't see this option, skip it: the database rules below
   already refuse every account except yours.
5. **Database:** open **Build → Firestore Database → Create database**. If asked for an edition choose **Standard**,
   pick a location near you (it cannot be changed later), and choose **Start in production mode**.
6. **Security rules:** in Firestore open the **Rules** tab, delete everything, paste the whole content of
   [`firebase/firestore.rules`](firebase/firestore.rules), and replace `PASTE-YOUR-UID-HERE` (keep the quotes)
   with the User UID from step 3. Click **Publish**.
7. **Web app settings:** click the gear icon → **Project settings** → **Your apps** → the **</>** (Web) button.
   Give it a nickname, leave Hosting unticked, **Register app**. Copy the values of `apiKey`, `authDomain`,
   `projectId` and `appId`.
8. Put those four values into [`docs/config.js`](docs/config.js), or send them to Claude to do it. They are not secret:
   they only name the project, and the rules from step 6 protect the data.

### 2. Optional extra lock-down

In Google Cloud console → **APIs & Services → Credentials**, open the "Browser key" Firebase created and,
under **Website restrictions**, allow only `https://kratoskumar.github.io/*`. Not required.

### 3. Switch on GitHub Pages (free hosting)

In this GitHub repository: **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
Choose the branch that has these files (`main` after merging, or this working branch) and the folder **/docs**,
then **Save**. After a minute the app is live at https://kratoskumar.github.io/claude_repo/.

### 4. Put it on both phones

- **iPhone (Safari):** open the address, tap **Share → Add to Home Screen**.
- **Android (Chrome):** open the address, menu **⋮ → Install app** (or **Add to Home screen**).
- Open **Saved → Sign in** once on each phone with the family email and password. Each phone stays signed in.

Share the password privately (in person or a password manager), never inside the app's notes.

## Using it

1. Choose **US rate** or **India rate**, and the date (defaults to today).
2. Enter the item **price** (tap $ USD or ₹ INR), the **gold weight** in grams and the **purity**.
   Tick or untick "Price includes GST" to match the price tag. Add stones/other charges if the price includes them.
3. Read the making charge as an amount, as % of gold value, and per gram. To use your jeweller's rate,
   type it into the 24K or the item-purity rate box. **Use market rate** switches back.
4. **Save** adds a name, product link, notes and an optional photo (shrunk to about 100–300 KB before upload).
   **Saved** lists everything; tap an item to see the photo, open the product page, edit it in the calculator,
   save a copy, or delete it.

## Free plan limits

Firebase Spark (free): 1 GiB of storage, 50,000 reads and 20,000 writes per day. With photos at about
100–300 KB, that is several thousand saved items, and two people's daily use is a tiny fraction of the
daily limits. The project never pauses for inactivity. GitHub Pages and the rate sources are free.

## Security

- Only the one Firebase account (by its UID) can read or write anything; everyone else, signed in or not, is refused.
  The rules also check the shape and size of every saved item and photo.
- Passwords are handled by Firebase (Google); the app never stores them. "Sign out" also wipes that phone's offline copy.
- Product links are only opened if they are normal web links (`https://…`), in a new tab.
- A strict Content Security Policy limits the page to its own code and the services listed above.

## Maintenance notes

- After changing any file in `docs/`, bump `VERSION` in **both** `docs/sw.js` and `docs/app.js`, so phones pick
  up the new version (they update automatically on next open).
- If India changes its gold import duty, edit it in the app (⚙ Settings) and/or update `DEFAULT_DUTY` in `docs/calc.js`.

## Development and tests

Requires Node 20+ and Java 21 (for the Firebase emulator). Playwright with Chromium must be installed.

```bash
npm install
npm run test:unit        # calculation, number parsing, rate fetching (live + failure cases)
npm run test:rules       # Firestore security rules in the emulator
npm run test:components  # photo shrinking + cloud saving in a real browser
npm run test:e2e         # 32 end-to-end steps on phone-sized screens (calculator, saving, sync, offline, updates)
npm run serve            # local copy at http://127.0.0.1:8000/claude_repo/
```
