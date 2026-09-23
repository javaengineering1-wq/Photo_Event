# Event Photo Contest

A tiny, self-contained web app for exactly one job: during an event, guests
upload photos from their phones; after the event, everyone gets 24 hours to
like their favorites; then the top 3 most-liked photos are revealed.

No accounts, no app install — guests just open a link, tap their name, and go.

## How it works

The whole app is driven by three timestamps you (the admin) set:

- **Event start** → uploads open
- **Event end** → uploads close, voting opens automatically
- **Event end + voting window (default 24h)** → voting closes, results are shown

Everyone sees the same phase at the same time, computed from the server's
clock — it doesn't matter what timezone a guest's phone is set to.

**Important:** this uses simple, "honor system" identification, not real
accounts. Guests type their own name to join — the app only guarantees each
name is unique at any given time, not that the person typing it is who they
claim to be, and there are no passwords. That's by design (keeps it
frictionless for a party/event), but don't use it for anything where
impersonation would be a real problem.

## Project layout

```
server.js          Express backend: API, phase logic, JSON-file storage
public/
  index.html/.js    Guest-facing app (login → upload → vote → results)
  admin.html/.js    Admin panel (password-protected)
  style.css         Shared styling
data/               Created automatically: contest.json + uploaded photos
```

Storage is a plain JSON file (`data/contest.json`), not a database engine —
this keeps the app dependency-free of anything that needs compiling, so
`npm install` works the same on any Node version or OS with zero extra
tools. It's not built for heavy concurrent traffic, but that's a non-issue
at the scale of one event's worth of uploads and likes.

## Running it locally

Requires Node.js 18+.

```bash
npm install
cp .env.example .env
# edit .env and set ADMIN_PASSWORD to something only you know
npm start
```

Then open:
- `http://localhost:3000` — the guest app
- `http://localhost:3000/admin.html` — the admin panel

## Setting up an event (admin panel)

1. Go to `/admin.html` and enter your admin password.
2. Under **Event timing**, set when the event starts and ends, and how many
   hours the voting window should stay open after it ends (default 24).
3. Guests pick their own username the first time they visit — no setup
   needed here. The **Registered guests** section shows who's joined and
   lets you remove someone (a typo, a troll, a name you want to free up);
   saving that list replaces it entirely, so only use it to make targeted
   removals, not as a guest list you maintain in advance.
4. Share the plain URL (e.g. `https://your-app.example.com`) with guests —
   no login link, no account needed.
5. During and after the event, use the **Moderation** section to delete any
   photo that shouldn't be in the contest.
6. When you're ready to run this again for a new event, use **Reset** to
   wipe all photos and likes while keeping your guest list.

## Deploying so guests can actually reach it (free, via Render)

This needs to run somewhere reachable from guests' phones — your laptop on
localhost won't do. [Render](https://render.com) offers a free web service
with no credit card required, which is enough for a single event.

**The one catch:** free Render services have an *ephemeral filesystem* —
every time the service redeploys, restarts, or "spins down" after 15
minutes with no traffic, everything in `data/` (uploaded photos, the
contest.json file) is wiped. Two things fix this:

1. **Keep it awake during the event** with a free uptime pinger (step 5
   below) so it never spins down and never loses data mid-event.
2. **Download a backup** from the admin panel's "Download backup" button
   any time you want a safety copy of the photos and current results —
   do this right after voting closes, before you tear anything down.

### Steps

1. **Push the code to GitHub.** Render deploys from a Git repository —
   there's no plain zip-upload option. If you don't have a GitHub account,
   [create a free one](https://github.com/signup) (just an email,
   username, and password — no card). Then, from inside this folder:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   ```
   Create a new empty repository on GitHub (github.com → "New repository"),
   then push:
   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
   git branch -M main
   git push -u origin main
   ```

2. **Sign up at [render.com](https://render.com)** (free, no card) — you
   can sign up directly with your GitHub account, which also connects it.

3. **Create the service:** Dashboard → New → Web Service → select your
   repo → Connect. Set:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free

4. **Add the admin password.** Under Environment, add an environment
   variable `ADMIN_PASSWORD` set to whatever you want (don't leave it as
   `change-me`). Render sets `PORT` itself — you don't need to add it.
   Click **Deploy**. After a couple of minutes you'll get a live URL like
   `https://your-app.onrender.com`.

5. **Set up a free keep-alive ping** so the service doesn't spin down and
   wipe your data during the event. Use a free monitor like
   [UptimeRobot](https://uptimerobot.com) or [cron-job.org](https://cron-job.org):
   point it at `https://your-app.onrender.com/api/status` every 5–10
   minutes, starting a little before your event and running through the
   end of the 24-hour voting window. Turn it off (or ignore it) after
   that — you don't need it once the results are in.

6. **Configure the event** at `https://your-app.onrender.com/admin.html`
   exactly as you did locally: set the timing and guest list.

7. **Right after voting closes**, open the admin panel and click
   **Download backup** to save a zip of every photo and the final results
   to your own computer — your permanent copy, independent of Render.

Whatever host you use, always set `ADMIN_PASSWORD` as an environment
variable on the host itself (not by uploading your `.env` file), and rely
on Render's automatic HTTPS so the password isn't sent in plain text.

### If you outgrow the free tier

For a bigger event, more reliability, or to skip the keep-alive-ping
workaround entirely, upgrade the Render service to a paid instance type
(Starter is a few dollars/month), attach a **persistent disk** (e.g.
mounted at `/var/data`), and set the environment variable `DATA_DIR=/var/data`.
The app will then store uploads and contest.json on that disk, which
survives restarts and redeploys automatically — no pinger needed.

## A couple of practical notes

- **iPhone photos (HEIC):** most modern mobile browsers convert photos to
  JPEG automatically when uploading through a web form, so this generally
  isn't an issue. If a guest's phone is set to the older "High Efficiency"
  camera format and their browser doesn't convert it, the photo may not
  preview correctly for other guests. If that comes up, you can ask guests
  to check Settings → Camera → Formats → "Most Compatible" on iOS.
- **Photo size:** uploads are capped at 15MB per photo — plenty for a phone
  photo, and keeps storage/bandwidth reasonable for a full event's worth of
  uploads.
- **Duplicate/self-likes:** everyone (including the photo's own uploader)
  can like any photo exactly once; tapping again un-likes it.
