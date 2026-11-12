# Book List

The shared book-rating app, now on **GitHub Pages** with the **Google Sheet** still as the database.

```
GitHub Pages (index.html, css/, js/)  ──fetch──▶  Apps Script web app (apps-script/)  ──▶  Google Sheet
         what people open                         checks who you are on every call       your data
```

## Who can do what

| | Anyone signed in | Admin (Beau) |
|---|---|---|
| See every book and everyone's ratings, reads, rankings, stats | ✓ | ✓ |
| Rate, mark read, rank — **own column only** | ✓ | ✓ |
| Add books, fix book details, rename a series, bulk import (paste/CSV) | ✓ | ✓ |
| Delete a book | only if nobody else has scored it | ✓ |
| Rename a person's column | own only | ✓ |
| Import tab sync, account list, unlink / reset password / remove accounts | | ✓ |

The server enforces these rules. Even if someone changes the page, a rating write always goes to their own column.

**Sign-in options:** Google · email + password · phone + password (once a phone number is saved on the profile).

**Seeded accounts:** Beau Stapley → `beaustapley@hotmail.com` → Beau column (admin). Kyler Kent → `kylersm6@gmail.com` → Kyler column.
If Kyler signs in with a different email, he taps **"I'm Kyler"** on the welcome screen. That option disappears after he claims the column, and you can **Unlink** from More → Accounts if someone else takes it by mistake.
New people sign up and tap **Start my column**. That adds their rating block to the sheet.

---

## Setup (about 20 minutes, once)

### 1. Apps Script (in the sheet's existing project)
1. Open the sheet → **Extensions → Apps Script**.
2. Replace `Code.gs` with `apps-script/Code.gs`. It's your file with `doGet`/`include` removed; nothing else changed except the menu.
3. Add two script files, `Auth` and `Api`, and paste in `Auth.gs` and `Api.gs`.
4. **Delete** the `Index`, `Styles` and `App` HTML files. The page now lives on GitHub.
5. Optional: Project Settings → tick *Show "appsscript.json"*, then paste `apps-script/appsscript.json` (V8 runtime, web-app settings).
6. In `Auth.gs`, check that `SEED` matches your banner names (`Beau`, `Kyler`).
7. Run **`setupAuth`** once and approve the permissions. This creates the hidden **Users** tab.

### 2. Google sign-in (skip to use only email/phone + password)
Use your **personal** Google account at [console.cloud.google.com](https://console.cloud.google.com):
1. Create a new project called "Book List".
2. **APIs & Services → OAuth consent screen**: choose External, app name "Book List", your email, then **Publish app**. It only asks for name and email, so Google doesn't need to review it.
3. **Credentials → Create credentials → OAuth client ID → Web application.**
   - Authorized JavaScript origins: `https://YOUR-GITHUB-USERNAME.github.io` (add `http://localhost:8000` if you want to test locally)
4. Copy the **Client ID** and paste it into **both** `AUTH.GOOGLE_CLIENT_ID` in `Auth.gs` and `GOOGLE_CLIENT_ID` in `js/config.js`.

### 3. Deploy the API
1. Apps Script → **Deploy → New deployment → Web app**.
2. Set **Execute as: Me** and **Who has access: Anyone**. This has to be *Anyone*, not "Anyone with a Google account", or the page can't reach it.
3. Copy the `/exec` URL and paste it into `API_URL` in `js/config.js`.

> When you change the script later, go to **Deploy → Manage deployments → ✏️ → Version: New version**. That keeps the same URL.

### 4. GitHub Pages
1. Create a repo (for example `book-list`) and upload everything in this folder, keeping the `css/`, `js/` and `apps-script/` folders.
2. Go to **Settings → Pages → Deploy from a branch → `main` / root**.
3. The site appears at `https://YOUR-GITHUB-USERNAME.github.io/book-list/` within about a minute.
4. Put that URL in the sheet's **App!A1** so Waypoint links to it. On iPhone, use Safari → Share → **Add to Home Screen**.

### 5. First sign-in
Sign in with Google as `beaustapley@hotmail.com`. You land on the Beau column as admin. Then send Kyler the link.

---

## Good to know
- **Keep the sheet private.** It doesn't need sharing, because the API runs as you. The repo can be public: the URL and Client ID aren't secrets.
- **Passwords** are salted and hashed in Script Properties, never in the sheet. Don't delete the `SESSION_SECRET` property; doing that signs everyone out.
- **Forgot password:** sign in with Google, then set a new one under Account within 10 minutes. Otherwise an admin can use **Reset password** to issue a temporary one.
- **Email sign-ups aren't verified** (the app doesn't send emails). Google sign-in is verified.
- **Sign out everywhere** (Account) ends sessions on every device. Sessions otherwise last 30 days and renew whenever the app is opened.
- The **old Apps Script page URL** now returns a short JSON message. The app only lives on GitHub now.
- After 6 wrong passwords, that email or phone number pauses for 15 minutes (an admin reset lifts it).

## Files
| File | What it is |
|---|---|
| `index.html`, `css/styles.css` | Page and styles (from Index.html / Styles.html) |
| `js/app.js` | The app (from App.html): API calls instead of `google.script.run`, plus view-only mode |
| `js/auth.js` | Sign-in, sign-up, "who are you?" claim, Account panel, admin list |
| `js/api.js` | Small fetch wrapper that carries the session token |
| `js/config.js` | **Edit this:** API URL and Google Client ID |
| `apps-script/Code.gs` | Sheet logic (unchanged apart from removing `doGet`) |
| `apps-script/Auth.gs` | Accounts, passwords, sessions, Google check, claim flow |
| `apps-script/Api.gs` | `doPost` router and the permission rules |
