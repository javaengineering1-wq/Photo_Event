require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');

// Override with DATA_DIR if you attach a persistent disk (e.g. on Render) --
// point it at the disk's mount path so uploads and the database survive
// restarts and redeploys automatically.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
const PORT = process.env.PORT || 3000;

// ---------- Database ----------
// Plain JSON file on disk, mirrored by an in-memory object. No native/compiled
// dependencies -- this avoids the "needs Python/Visual Studio to build a
// native module" problem entirely, at the cost of not being suited to heavy
// concurrent write traffic. That trade-off is fine for one event's worth of
// uploads and likes.
const DB_FILE = path.join(DATA_DIR, 'contest.json');

function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      return {
        config: parsed.config || {},
        users: Array.isArray(parsed.users) ? parsed.users : [],
        photos: Array.isArray(parsed.photos) ? parsed.photos : [],
        likes: Array.isArray(parsed.likes) ? parsed.likes : [],
      };
    } catch (err) {
      console.error('contest.json was unreadable, backing it up and starting fresh:', err.message);
      try {
        fs.copyFileSync(DB_FILE, `${DB_FILE}.corrupt-${Date.now()}.bak`);
      } catch (_) {
        /* ignore */
      }
    }
  }
  return { config: {}, users: [], photos: [], likes: [] };
}

const store = loadDB();

// Synchronous, atomic-ish (write-then-rename) save. Called after every
// mutation; fine at this scale, and simpler than a debounce/queue.
function saveDB() {
  const tmpFile = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2));
  fs.renameSync(tmpFile, DB_FILE);
}

function getConfig() {
  return {
    eventStart: store.config.eventStart || null,
    eventEnd: store.config.eventEnd || null,
    votingHours: parseFloat(store.config.votingHours || 24),
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

// ---------- App ----------
const app = express();
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public')));

// Admin auth middleware
function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key');
  if (!key || key !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password.' });
  }
  next();
}

// Multer setup: images only, 15MB cap
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(0, 10);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed.'));
  },
});

// ---------- Public API ----------

app.get('/api/status', (req, res) => {
  const config = getConfig();
  const now = new Date();
  const phase = getPhase(config, now);
  const votingEnd =
    config.eventEnd && config.votingHours
      ? new Date(new Date(config.eventEnd).getTime() + config.votingHours * 3600 * 1000).toISOString()
      : null;
  res.json({
    phase,
    serverNow: now.toISOString(),
    eventStart: config.eventStart,
    eventEnd: config.eventEnd,
    votingEnd,
    votingHours: config.votingHours,
  });
});

function sortedUsers() {
  return [...store.users].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

app.get('/api/users', (req, res) => {
  res.json({ users: sortedUsers() });
});

const MAX_USERNAME_LENGTH = 24;

app.post('/api/register', (req, res) => {
  const raw = (req.body && req.body.username) || '';
  const name = String(raw).trim();

  if (!name) {
    return res.status(400).json({ error: 'Enter a name to join with.' });
  }
  if (name.length > MAX_USERNAME_LENGTH) {
    return res.status(400).json({ error: `Names can be at most ${MAX_USERNAME_LENGTH} characters.` });
  }
  const taken = store.users.some((u) => u.toLowerCase() === name.toLowerCase());
  if (taken) {
    return res.status(409).json({ error: 'That name is already taken — try another.' });
  }

  store.users.push(name);
  saveDB();
  res.json({ ok: true, username: name });
});

app.post('/api/upload', (req, res) => {
  const config = getConfig();
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
    if (!store.users.includes(username)) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'Unknown username.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No photo received.' });
    }

    const id = uuidv4();
    store.photos.push({
      id,
      username,
      filename: req.file.filename,
      original_name: req.file.originalname || null,
      uploaded_at: Date.now(),
    });
    saveDB();

    res.json({ ok: true, id });
  });
});

function photoToPublic(row, viewerUsername) {
  const likeCount = store.likes.filter((l) => l.photo_id === row.id).length;
  const likedByMe = viewerUsername
    ? store.likes.some((l) => l.photo_id === row.id && l.username === viewerUsername)
    : false;
  return {
    id: row.id,
    username: row.username,
    url: `/uploads/${row.filename}`,
    uploadedAt: row.uploaded_at,
    likeCount,
    likedByMe,
  };
}

app.get('/api/photos', (req, res) => {
  const viewer = req.query.username || null;
  const rows = [...store.photos].sort((a, b) => b.uploaded_at - a.uploaded_at);
  res.json({ photos: rows.map((r) => photoToPublic(r, viewer)) });
});

app.post('/api/like', (req, res) => {
  const config = getConfig();
  const phase = getPhase(config, new Date());
  if (phase !== 'voting') {
    return res.status(403).json({ error: 'Liking is only allowed during the 24-hour voting window.' });
  }
  const { username, photoId } = req.body || {};
  if (!username || !photoId) {
    return res.status(400).json({ error: 'Missing username or photoId.' });
  }
  if (!store.users.includes(username)) return res.status(403).json({ error: 'Unknown username.' });

  const photo = store.photos.find((p) => p.id === photoId);
  if (!photo) return res.status(404).json({ error: 'Photo not found.' });

  const existingIndex = store.likes.findIndex((l) => l.photo_id === photoId && l.username === username);

  if (existingIndex !== -1) {
    store.likes.splice(existingIndex, 1);
    saveDB();
    res.json({ ok: true, liked: false });
  } else {
    store.likes.push({ photo_id: photoId, username, created_at: Date.now() });
    saveDB();
    res.json({ ok: true, liked: true });
  }
});

app.get('/api/download', (req, res) => {
  const config = getConfig();
  const phase = getPhase(config, new Date());
  if (phase !== 'results') {
    return res.status(403).json({ error: 'Downloads open once results are in.' });
  }

  let selected = [...store.photos].sort((a, b) => a.uploaded_at - b.uploaded_at);
  if (req.query.ids) {
    const idSet = new Set(String(req.query.ids).split(',').map((s) => s.trim()).filter(Boolean));
    selected = selected.filter((p) => idSet.has(p.id));
    if (selected.length === 0) {
      return res.status(404).json({ error: 'No matching photos.' });
    }
  }

  const label = req.query.ids ? 'selected-photos' : 'all-photos';
  res.attachment(`photo-contest-${label}-${Date.now()}.zip`);
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

app.get('/api/results', (req, res) => {
  const withCounts = store.photos.map((r) => photoToPublic(r, null));
  withCounts.sort((a, b) => b.likeCount - a.likeCount || a.uploadedAt - b.uploadedAt);
  res.json({ top: withCounts.slice(0, 3), all: withCounts });
});

// ---------- Admin API ----------

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ error: 'Incorrect password.' });
});

app.get('/api/admin/config', requireAdmin, (req, res) => {
  res.json({ config: getConfig(), users: sortedUsers() });
});

app.post('/api/admin/config', requireAdmin, (req, res) => {
  const { eventStart, eventEnd, votingHours } = req.body || {};
  if (!eventStart || !eventEnd) {
    return res.status(400).json({ error: 'eventStart and eventEnd are required.' });
  }
  if (new Date(eventEnd) <= new Date(eventStart)) {
    return res.status(400).json({ error: 'Event end must be after event start.' });
  }
  store.config.eventStart = new Date(eventStart).toISOString();
  store.config.eventEnd = new Date(eventEnd).toISOString();
  store.config.votingHours = Number(votingHours || 24);
  saveDB();
  res.json({ ok: true, config: getConfig() });
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { usernames } = req.body || {};
  if (!Array.isArray(usernames)) {
    return res.status(400).json({ error: 'usernames must be an array.' });
  }
  const clean = [...new Set(usernames.map((u) => String(u).trim()).filter(Boolean))];
  store.users = clean;
  saveDB();

  res.json({ ok: true, users: clean });
});

app.delete('/api/admin/photos/:id', requireAdmin, (req, res) => {
  const photo = store.photos.find((p) => p.id === req.params.id);
  if (!photo) return res.status(404).json({ error: 'Not found.' });
  store.likes = store.likes.filter((l) => l.photo_id !== photo.id);
  store.photos = store.photos.filter((p) => p.id !== photo.id);
  saveDB();
  fs.unlink(path.join(UPLOAD_DIR, photo.filename), () => {});
  res.json({ ok: true });
});

app.get('/api/admin/export', requireAdmin, (req, res) => {
  const photoRows = [...store.photos].sort((a, b) => a.uploaded_at - b.uploaded_at);
  const results = photoRows
    .map((r) => photoToPublic(r, null))
    .sort((a, b) => b.likeCount - a.likeCount || a.uploadedAt - b.uploadedAt);

  res.attachment(`photo-contest-backup-${Date.now()}.zip`);
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

  archive.append(JSON.stringify({ exportedAt: new Date().toISOString(), results }, null, 2), {
    name: 'results.json',
  });

  archive.finalize();
});

app.post('/api/admin/reset', requireAdmin, (req, res) => {
  // Wipes all photos and likes (keeps usernames and event config). Use between events.
  const photos = store.photos;
  store.likes = [];
  store.photos = [];
  saveDB();
  for (const p of photos) fs.unlink(path.join(UPLOAD_DIR, p.filename), () => {});
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Event photo contest running on http://localhost:${PORT}`);
});
