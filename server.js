require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');

// Override with DATA_DIR if you attach a persistent disk (e.g. on Render) --
// point it at the disk's mount path so uploads and the database survive
// restarts and redeploys automatically.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

// ---------- Database ----------
// Plain JSON file on disk, mirrored by an in-memory object. No native/compiled
// dependencies -- this avoids the "needs Python/Visual Studio to build a
// native module" problem entirely, at the cost of not being suited to heavy
// concurrent write traffic or a large number of simultaneous events. That
// trade-off is fine while this is a small multi-event tool; a real database
// is worth revisiting if usage grows a lot.
const DB_FILE = path.join(DATA_DIR, 'db.json');

function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      return {
        hosts: Array.isArray(parsed.hosts) ? parsed.hosts : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
        eventUsers: Array.isArray(parsed.eventUsers) ? parsed.eventUsers : [],
        photos: Array.isArray(parsed.photos) ? parsed.photos : [],
        likes: Array.isArray(parsed.likes) ? parsed.likes : [],
      };
    } catch (err) {
      console.error('db.json was unreadable, backing it up and starting fresh:', err.message);
      try {
        fs.copyFileSync(DB_FILE, `${DB_FILE}.corrupt-${Date.now()}.bak`);
      } catch (_) {
        /* ignore */
      }
    }
  }
  return { hosts: [], sessions: [], events: [], eventUsers: [], photos: [], likes: [] };
}

const store = loadDB();

// Synchronous, atomic-ish (write-then-rename) save. Called after every
// mutation; fine at this scale, and simpler than a debounce/queue.
function saveDB() {
  const tmpFile = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2));
  fs.renameSync(tmpFile, DB_FILE);
}

// ---------- Helpers ----------

function generateSlug() {
  return crypto.randomBytes(6).toString('base64url'); // 8 URL-safe chars
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getEventConfig(event) {
  return {
    eventStart: event.eventStart || null,
    eventEnd: event.eventEnd || null,
    votingHours: parseFloat(event.votingHours || 24),
  };
}

function getPhase(config, now) {
  if (!config.eventStart || !config.eventEnd) return 'not_configured';
  const start = new Date(config.eventStart);
  const end = new Date(config.eventEnd);
  const votingEnd = new Date(end.getTime() + config.votingHours * 3600 * 1000);

  if (now < start) return 'before';
  if (now <= end) return 'upload';
  if (now <= votingEnd) return 'voting';
  return 'results';
}

function eventUsersFor(eventId) {
  return store.eventUsers.filter((u) => u.eventId === eventId).map((u) => u.username);
}

function sortedEventUsers(eventId) {
  return eventUsersFor(eventId).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function photoToPublic(row, viewerUsername) {
  const likeCount = store.likes.filter((l) => l.photoId === row.id).length;
  const likedByMe = viewerUsername
    ? store.likes.some((l) => l.photoId === row.id && l.username === viewerUsername)
    : false;
  return {
    id: row.id,
    username: row.username,
    url: `/uploads/${row.filename}`,
    uploadedAt: row.uploadedAt,
    likeCount,
    likedByMe,
  };
}

function guestUrlFor(req, event) {
  return `${req.protocol}://${req.get('host')}/e/${event.slug}`;
}

function eventSummary(req, event) {
  const photoCount = store.photos.filter((p) => p.eventId === event.id).length;
  const guestCount = store.eventUsers.filter((u) => u.eventId === event.id).length;
  return {
    id: event.id,
    name: event.name,
    slug: event.slug,
    guestUrl: guestUrlFor(req, event),
    config: getEventConfig(event),
    phase: getPhase(getEventConfig(event), new Date()),
    photoCount,
    guestCount,
    createdAt: event.createdAt,
  };
}

// ---------- App ----------
const app = express();
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d' }));
// index: false -- we serve landing/host/event pages via explicit routes below,
// since which page belongs at "/" now depends on multi-event routing, not a
// single default index.html.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/e/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'event.html')));

// ---------- Host auth ----------

function requireHost(req, res, next) {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in.' });

  const session = store.sessions.find((s) => s.token === token);
  if (!session || new Date(session.expiresAt) < new Date()) {
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }
  const host = store.hosts.find((h) => h.id === session.hostId);
  if (!host) return res.status(401).json({ error: 'Not signed in.' });

  req.hostId = host.id;
  next();
}

// Loads the event for :eventId and confirms it belongs to req.hostId.
// Sends 404 (not 403) on mismatch so a host can't probe for event IDs that
// aren't theirs.
function loadOwnedEvent(req, res) {
  const event = store.events.find((e) => e.id === req.params.eventId);
  if (!event || event.hostId !== req.hostId) {
    res.status(404).json({ error: 'Event not found.' });
    return null;
  }
  return event;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/host/register', async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');

  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (store.hosts.some((h) => h.email === email)) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const host = { id: uuidv4(), email, passwordHash, createdAt: new Date().toISOString() };
  store.hosts.push(host);

  const token = generateToken();
  store.sessions.push({
    token,
    hostId: host.id,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });
  saveDB();

  res.json({ ok: true, token, email: host.email });
});

app.post('/api/host/login', async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');

  const host = store.hosts.find((h) => h.email === email);
  const genericError = { error: 'Incorrect email or password.' };
  if (!host) return res.status(401).json(genericError);

  const ok = await bcrypt.compare(password, host.passwordHash);
  if (!ok) return res.status(401).json(genericError);

  const token = generateToken();
  store.sessions.push({
    token,
    hostId: host.id,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });
  saveDB();

  res.json({ ok: true, token, email: host.email });
});

app.post('/api/host/logout', requireHost, (req, res) => {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  store.sessions = store.sessions.filter((s) => s.token !== token);
  saveDB();
  res.json({ ok: true });
});

// ---------- Host event management ----------

app.get('/api/host/events', requireHost, (req, res) => {
  const mine = store.events
    .filter((e) => e.hostId === req.hostId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ events: mine.map((e) => eventSummary(req, e)) });
});

app.post('/api/host/events', requireHost, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Give the event a name.' });

  const event = {
    id: uuidv4(),
    hostId: req.hostId,
    slug: generateSlug(),
    name,
    eventStart: null,
    eventEnd: null,
    votingHours: 24,
    createdAt: new Date().toISOString(),
  };
  store.events.push(event);
  saveDB();

  res.json({ ok: true, event: eventSummary(req, event) });
});

app.get('/api/host/events/:eventId', requireHost, (req, res) => {
  const event = loadOwnedEvent(req, res);
  if (!event) return;
  res.json({ event: eventSummary(req, event), users: sortedEventUsers(event.id) });
});

app.patch('/api/host/events/:eventId', requireHost, (req, res) => {
  const event = loadOwnedEvent(req, res);
  if (!event) return;

  const { name, eventStart, eventEnd, votingHours } = req.body || {};
  if (name !== undefined) {
    const clean = String(name).trim();
    if (!clean) return res.status(400).json({ error: 'Name cannot be empty.' });
    event.name = clean;
  }
  if (eventStart !== undefined && eventEnd !== undefined) {
    if (!eventStart || !eventEnd) {
      return res.status(400).json({ error: 'eventStart and eventEnd are required together.' });
    }
    if (new Date(eventEnd) <= new Date(eventStart)) {
      return res.status(400).json({ error: 'Event end must be after event start.' });
    }
    event.eventStart = new Date(eventStart).toISOString();
    event.eventEnd = new Date(eventEnd).toISOString();
  }
  if (votingHours !== undefined) {
    event.votingHours = Number(votingHours || 24);
  }
  saveDB();
  res.json({ ok: true, event: eventSummary(req, event) });
});

app.delete('/api/host/events/:eventId', requireHost, (req, res) => {
  const event = loadOwnedEvent(req, res);
  if (!event) return;

  const photos = store.photos.filter((p) => p.eventId === event.id);
  store.likes = store.likes.filter((l) => l.eventId !== event.id);
  store.photos = store.photos.filter((p) => p.eventId !== event.id);
  store.eventUsers = store.eventUsers.filter((u) => u.eventId !== event.id);
  store.events = store.events.filter((e) => e.id !== event.id);
  saveDB();
  for (const p of photos) fs.unlink(path.join(UPLOAD_DIR, p.filename), () => {});

  res.json({ ok: true });
});

app.post('/api/host/events/:eventId/users', requireHost, (req, res) => {
  const event = loadOwnedEvent(req, res);
  if (!event) return;

  const { usernames } = req.body || {};
  if (!Array.isArray(usernames)) return res.status(400).json({ error: 'usernames must be an array.' });
  const clean = [...new Set(usernames.map((u) => String(u).trim()).filter(Boolean))];

  store.eventUsers = store.eventUsers.filter((u) => u.eventId !== event.id);
  for (const username of clean) store.eventUsers.push({ eventId: event.id, username });
  saveDB();

  res.json({ ok: true, users: sortedEventUsers(event.id) });
});

app.delete('/api/host/events/:eventId/photos/:photoId', requireHost, (req, res) => {
  const event = loadOwnedEvent(req, res);
  if (!event) return;

  const photo = store.photos.find((p) => p.id === req.params.photoId && p.eventId === event.id);
  if (!photo) return res.status(404).json({ error: 'Not found.' });
  store.likes = store.likes.filter((l) => l.photoId !== photo.id);
  store.photos = store.photos.filter((p) => p.id !== photo.id);
  saveDB();
  fs.unlink(path.join(UPLOAD_DIR, photo.filename), () => {});
  res.json({ ok: true });
});

app.post('/api/host/events/:eventId/reset', requireHost, (req, res) => {
  const event = loadOwnedEvent(req, res);
  if (!event) return;

  // Wipes photos/likes for this event only (keeps guest list and timing). Use between events.
  const photos = store.photos.filter((p) => p.eventId === event.id);
  store.likes = store.likes.filter((l) => l.eventId !== event.id);
  store.photos = store.photos.filter((p) => p.eventId !== event.id);
  saveDB();
  for (const p of photos) fs.unlink(path.join(UPLOAD_DIR, p.filename), () => {});
  res.json({ ok: true });
});

app.get('/api/host/events/:eventId/export', requireHost, (req, res) => {
  const event = loadOwnedEvent(req, res);
  if (!event) return;

  const photoRows = store.photos.filter((p) => p.eventId === event.id).sort((a, b) => a.uploadedAt - b.uploadedAt);
  const results = photoRows
    .map((r) => photoToPublic(r, null))
    .sort((a, b) => b.likeCount - a.likeCount || a.uploadedAt - b.uploadedAt);

  res.attachment(`${event.name.replace(/[^a-z0-9]+/gi, '-')}-backup-${Date.now()}.zip`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('Export failed:', err);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  archive.pipe(res);

  photoRows.forEach((p, i) => {
    const filePath = path.join(UPLOAD_DIR, p.filename);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(p.filename);
      const safeName = `${String(i + 1).padStart(3, '0')}_${p.username}${ext}`;
      archive.file(filePath, { name: `photos/${safeName}` });
    }
  });

  archive.append(JSON.stringify({ event: event.name, exportedAt: new Date().toISOString(), results }, null, 2), {
    name: 'results.json',
  });

  archive.finalize();
});

// ---------- Multer (shared across all events) ----------

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(0, 10);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  // The browser resizes/re-encodes photos before sending them, so most
  // uploads land well under 1-2MB. This higher ceiling is just a safety net
  // for the rare case that falls back to sending the original file untouched.
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // iOS Safari sometimes reports an empty/blank mimetype for HEIC photos
    // picked from the library, so we also accept based on file extension
    // rather than trusting the reported mimetype alone.
    const looksLikeImage =
      /^image\//.test(file.mimetype) || /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?)$/i.test(file.originalname || '');
    if (looksLikeImage) cb(null, true);
    else cb(new Error('Only image files are allowed.'));
  },
});

// ---------- Guest API (scoped by event slug, no auth) ----------

function loadEventBySlug(req, res) {
  const event = store.events.find((e) => e.slug === req.params.slug);
  if (!event) {
    res.status(404).json({ error: 'This event link is invalid or the event no longer exists.' });
    return null;
  }
  return event;
}

app.get('/api/e/:slug/status', (req, res) => {
  const event = loadEventBySlug(req, res);
  if (!event) return;

  const config = getEventConfig(event);
  const now = new Date();
  const phase = getPhase(config, now);
  const votingEnd =
    config.eventEnd && config.votingHours
      ? new Date(new Date(config.eventEnd).getTime() + config.votingHours * 3600 * 1000).toISOString()
      : null;
  res.json({
    eventName: event.name,
    phase,
    serverNow: now.toISOString(),
    eventStart: config.eventStart,
    eventEnd: config.eventEnd,
    votingEnd,
    votingHours: config.votingHours,
  });
});

app.get('/api/e/:slug/users', (req, res) => {
  const event = loadEventBySlug(req, res);
  if (!event) return;
  res.json({ users: sortedEventUsers(event.id) });
});

const MAX_USERNAME_LENGTH = 24;

app.post('/api/e/:slug/register', (req, res) => {
  const event = loadEventBySlug(req, res);
  if (!event) return;

  const raw = (req.body && req.body.username) || '';
  const name = String(raw).trim();

  if (!name) return res.status(400).json({ error: 'Enter a name to join with.' });
  if (name.length > MAX_USERNAME_LENGTH) {
    return res.status(400).json({ error: `Names can be at most ${MAX_USERNAME_LENGTH} characters.` });
  }
  const taken = eventUsersFor(event.id).some((u) => u.toLowerCase() === name.toLowerCase());
  if (taken) return res.status(409).json({ error: 'That name is already taken — try another.' });

  store.eventUsers.push({ eventId: event.id, username: name });
  saveDB();
  res.json({ ok: true, username: name });
});

app.post('/api/e/:slug/upload', (req, res) => {
  const event = loadEventBySlug(req, res);
  if (!event) return;

  const config = getEventConfig(event);
  const phase = getPhase(config, new Date());
  if (phase !== 'upload') {
    return res.status(403).json({ error: 'Uploads are only allowed during the event window.' });
  }

  upload.single('photo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const { username } = req.body;
    if (!username) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Missing username.' });
    }
    if (!eventUsersFor(event.id).includes(username)) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'Unknown username.' });
    }
    if (!req.file) return res.status(400).json({ error: 'No photo received.' });

    const id = uuidv4();
    store.photos.push({
      id,
      eventId: event.id,
      username,
      filename: req.file.filename,
      originalName: req.file.originalname || null,
      uploadedAt: Date.now(),
    });
    saveDB();

    res.json({ ok: true, id });
  });
});

app.get('/api/e/:slug/photos', (req, res) => {
  const event = loadEventBySlug(req, res);
  if (!event) return;

  const viewer = req.query.username || null;
  const rows = store.photos.filter((p) => p.eventId === event.id).sort((a, b) => b.uploadedAt - a.uploadedAt);
  res.json({ photos: rows.map((r) => photoToPublic(r, viewer)) });
});

app.post('/api/e/:slug/like', (req, res) => {
  const event = loadEventBySlug(req, res);
  if (!event) return;

  const config = getEventConfig(event);
  const phase = getPhase(config, new Date());
  if (phase !== 'voting') {
    return res.status(403).json({ error: 'Liking is only allowed during the 24-hour voting window.' });
  }
  const { username, photoId } = req.body || {};
  if (!username || !photoId) return res.status(400).json({ error: 'Missing username or photoId.' });
  if (!eventUsersFor(event.id).includes(username)) return res.status(403).json({ error: 'Unknown username.' });

  const photo = store.photos.find((p) => p.id === photoId && p.eventId === event.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found.' });

  const existingIndex = store.likes.findIndex(
    (l) => l.eventId === event.id && l.photoId === photoId && l.username === username
  );

  if (existingIndex !== -1) {
    store.likes.splice(existingIndex, 1);
    saveDB();
    res.json({ ok: true, liked: false });
  } else {
    store.likes.push({ eventId: event.id, photoId, username, createdAt: Date.now() });
    saveDB();
    res.json({ ok: true, liked: true });
  }
});

app.get('/api/e/:slug/results', (req, res) => {
  const event = loadEventBySlug(req, res);
  if (!event) return;

  const rows = store.photos.filter((p) => p.eventId === event.id);
  const withCounts = rows.map((r) => photoToPublic(r, null));
  withCounts.sort((a, b) => b.likeCount - a.likeCount || a.uploadedAt - b.uploadedAt);
  res.json({ top: withCounts.slice(0, 3), all: withCounts });
});

app.get('/api/e/:slug/download', (req, res) => {
  const event = loadEventBySlug(req, res);
  if (!event) return;

  const config = getEventConfig(event);
  const phase = getPhase(config, new Date());
  if (phase !== 'results') {
    return res.status(403).json({ error: 'Downloads open once results are in.' });
  }

  let selected = store.photos.filter((p) => p.eventId === event.id).sort((a, b) => a.uploadedAt - b.uploadedAt);
  if (req.query.ids) {
    const idSet = new Set(String(req.query.ids).split(',').map((s) => s.trim()).filter(Boolean));
    selected = selected.filter((p) => idSet.has(p.id));
    if (selected.length === 0) return res.status(404).json({ error: 'No matching photos.' });
  }

  const label = req.query.ids ? 'selected-photos' : 'all-photos';
  res.attachment(`${event.name.replace(/[^a-z0-9]+/gi, '-')}-${label}-${Date.now()}.zip`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('Download failed:', err);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  archive.pipe(res);

  selected.forEach((p, i) => {
    const filePath = path.join(UPLOAD_DIR, p.filename);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(p.filename);
      const safeName = `${String(i + 1).padStart(3, '0')}_${p.username}${ext}`;
      archive.file(filePath, { name: safeName });
    }
  });

  archive.finalize();
});

app.listen(PORT, () => {
  console.log(`Event photo contest (multi-event) running on http://localhost:${PORT}`);
});
