# Event Photo Contest

A web app for running photo contests at events: during the event, guests
upload photos from their phones; after it ends, everyone gets a voting
window (24 hours by default) to like their favorites; then the top 3
most-liked photos are revealed.

**This app is multi-event.** You (the host) create an account, and can run
as many separate events as you like — a wedding, then a birthday party, then
a work event — each fully isolated from the others, each with its own
shareable guest link. Guests never need an account or an app install: they
just open the link you send them, tap a username, and go.

## How it works

Each event is driven by three timestamps its host sets in the **host
dashboard**:

- **Event start** → uploads open
- **Event end** → uploads close, voting opens automatically
- **Event end + voting window (default 24h)** → voting closes, results are shown

Everyone looking at a given event sees the same phase at the same time,
computed from the server's clock — it doesn't matter what timezone a
guest's phone is set to.

**Guest identity:** guests type their own name to join an event, and set a
4-digit PIN at the same time. Returning to vote from the *same* phone is
instant (no PIN needed again) — but claiming that name from a different
device requires the PIN. This means a fellow guest can no longer just tap
someone else's name and vote as them; they'd need to know that person's
PIN. It's still lighter-weight than a real account (no email, no recovery
flow — if a guest forgets their PIN and loses their phone's local data,
they can't get that identity back and would need to join under a new
name), which is the right trade-off for a party/event, but worth knowing.
Hosts, by contrast, have real accounts (email + password) — that's what
makes their events private to them.

## Project layout

```
server.js            Express backend: host auth, per-event API, JSON-file storage
public/
  landing.html        Bare "/" -- points visitors to the host dashboard
  host.html/.js        Host dashboard: sign in, manage all your events
  event.html/.js/style.css   Guest-facing app for one event (login → upload → vote → results)
  style.css            Shared styling for all three
data/                 Created automatically: db.json + uploaded photos
```

Storage is a plain JSON file (`data/db.json`), not a database engine — this
keeps the app dependency-free of anything that needs compiling, so
`npm install` works the same on any Node version or OS with zero extra
tools (this includes `bcryptjs`, used for host password hashing, which is
pure JavaScript with no native/compiled component either). This is a
reasonable trade-off for a small number of hosts each running occasional
events; it is **not** built for heavy concurrent traffic or a large number
of simultaneous events, and a real database is worth considering if usage
ever grows substantially.

## URLs at a glance

- `/` — a simple landing page
- `/host` — the host dashboard (sign in / create account, manage events)
- `/e/<slug>` — one specific event's guest page (the link you share with guests)

Each event gets its own random slug (e.g. `/e/sSiH0ZEk`) when you create it
in the dashboard — that's the link to copy and send to guests. Nothing
about it is guessable from another event's link.

## Running it locally

Requires Node.js 18+.

```bash
npm install
npm start
```

Then open `http://localhost:3000/host` to create a host account and your
first event.

## Setting up an event (host dashboard)

1. Go to `/host`, create an account (just an email and password — this is
   your own account, stored only in this app, not shared with anything
   else), and sign in.
2. Click **+ Create new event** and give it a name.
3. On the event's page, set **Event timing**: when it starts and ends, and
   how many hours the voting window should stay open afterward.
4. Copy the **guest link** shown at the top and share it however you like
   (text, email, a printed card at the event) — no login link, no account
   needed on the guest's end.
5. Guests pick their own username and a 4-digit PIN the first time they
   visit that link — no
   setup needed here. The **Registered guests** section shows who's joined
   and lets you remove someone (a typo, a troll, a name you want to free
   up); saving that list replaces it entirely, so only use it to make
   targeted removals, not as a guest list you maintain in advance.
6. During and after the event, use **Moderation** to delete any photo that
   shouldn't be in the contest.
7. Use **Download backup** any time for a zip of every photo plus the
   current results — do this right after voting closes as your permanent
   copy.
8. **Reset** clears an event's photos and likes while keeping its guest
   list and timing, for reusing the same event link again. **Delete**
   removes the event entirely, including its guest link.

Everything above is scoped to one event at a time — switching between
events (via "← All events" on the dashboard) doesn't affect any other
event's guests, photos, or settings.

## Deploying so guests can actually reach it (free, via Render)

This needs to run somewhere reachable from guests' phones — your laptop on
localhost won't do. [Render](https://render.com) offers a free web service
with no credit card required.

**The one catch:** free Render services have an *ephemeral filesystem* —
every time the service redeploys, restarts, or "spins down" after 15
minutes with no traffic, everything in `data/` (host accounts, every
event, all uploaded photos) is wiped. Two things fix this:

1. **Keep it awake during any event you're running** with a free uptime
   pinger (step 5 below) so it never spins down and never loses data
   mid-event.
2. **Download a backup** from each event's dashboard page any time you
   want a safety copy — do this right after voting closes, before you
   tear anything down.

Because host accounts and *every* event now live in the same `data/`
folder, this ephemeral-storage risk applies to your whole account, not
just one event — worth keeping in mind before you rely on the free tier
for anything you really don't want to lose.

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

   No environment variables are required to get started — Render sets
   `PORT` itself, and host accounts are created through `/host`, not an
   env var. Click **Deploy**. After a couple of minutes you'll get a live
   URL like `https://your-app.onrender.com`.

4. **Set up a free keep-alive ping** so the service doesn't spin down and
   wipe your data during an event. Use a free monitor like
   [UptimeRobot](https://uptimerobot.com) or [cron-job.org](https://cron-job.org):
   point it at `https://your-app.onrender.com/api/e/<any-slug>/status` (any
   real event's status endpoint works fine as a ping target) every 5–10
   minutes, starting a little before your event and running through the
   end of the voting window.

5. **Create your host account and event** at
   `https://your-app.onrender.com/host`, exactly as you did locally.

6. **Right after voting closes**, open that event's dashboard page and
   click **Download backup** to save a zip of every photo and the final
   results to your own computer — your permanent copy, independent of
   Render.

### If you outgrow the free tier

For more reliability, more simultaneous events, or to skip the
keep-alive-ping workaround entirely, upgrade the Render service to a paid
instance type (Starter is a few dollars/month) and attach a **persistent
disk** (e.g. mounted at `/var/data`), then set the environment variable
`DATA_DIR=/var/data`. The app will then store host accounts, events, and
uploads on that disk, which survives restarts and redeploys automatically —
no pinger needed.

## A couple of practical notes

- **iPhone photos:** every photo is resized and re-encoded to a standard
  JPEG in the guest's browser before it's uploaded, which sidesteps both
  oversized modern phone photos and HEIC format quirks. If that step fails
  for any reason, the app falls back to uploading the original file
  untouched.
- **Photo size:** uploads are capped at 25MB per photo as a safety net for
  that fallback case — in the normal case, resized uploads land well under
  1-2MB.
- **Duplicate/self-likes:** everyone (including the photo's own uploader)
  can like any photo exactly once; tapping again un-likes it.
- **Host sessions** last 30 days before you need to sign in again on a
  given device.
