(() => {
  const STORAGE_KEY_PREFIX = 'photocontest.username.';
  const TOKEN_KEY_PREFIX = 'photocontest.token.';

  const slugMatch = window.location.pathname.match(/^\/e\/([^/]+)/);
  const SLUG = slugMatch ? slugMatch[1] : null;
  const API = SLUG ? `/api/e/${encodeURIComponent(SLUG)}` : null;
  // Username is stored per-event-slug, not globally -- otherwise joining a
  // second event on the same phone would collide with (or overwrite) your
  // username from the first one.
  const STORAGE_KEY = SLUG ? `${STORAGE_KEY_PREFIX}${SLUG}` : null;

  // Each verified (name, this device) pair gets its own cached token, keyed
  // by lowercase name so a device that's already proven it owns "Alex" (via
  // registering or entering the PIN once) can tap back into that name
  // instantly next time, without needing the PIN again. A device that has
  // never proven it owns a given name has no token for it and must supply
  // the PIN -- that's the actual fix for "anyone can tap any name."
  function tokenStorageKey(name) {
    return `${TOKEN_KEY_PREFIX}${SLUG}.${name.toLowerCase()}`;
  }
  function getCachedToken(name) {
    return SLUG ? localStorage.getItem(tokenStorageKey(name)) : null;
  }
  function setCachedToken(name, token) {
    if (SLUG) localStorage.setItem(tokenStorageKey(name), token);
  }

  const el = (id) => document.getElementById(id);
  const screens = {
    unconfigured: el('screen-unconfigured'),
    login: el('screen-login'),
    before: el('screen-before'),
    upload: el('screen-upload'),
    voting: el('screen-voting'),
    results: el('screen-results'),
  };

  let status = null;
  let clockOffsetMs = 0; // serverNow - clientNow, sampled at fetch time
  let username = SLUG ? localStorage.getItem(STORAGE_KEY) : null;
  let guestToken = username ? getCachedToken(username) : null;
  let usersList = [];
  let pollTimer = null;
  let countdownTimer = null;

  function showScreen(name) {
    Object.entries(screens).forEach(([key, node]) => {
      node.classList.toggle('hidden', key !== name);
    });
  }

  function setPhaseChip(phase) {
    const chip = el('phaseChip');
    const label = el('phaseLabel');
    chip.className = 'phase-chip';
    const map = {
      not_configured: 'Setting up',
      before: 'Not started',
      upload: 'Upload photos',
      voting: 'Vote now',
      results: 'Results are in',
    };
    label.textContent = map[phase] || '…';
    if (phase === 'upload') chip.classList.add('upload');
    if (phase === 'voting') chip.classList.add('voting');
    if (phase === 'results') chip.classList.add('results');
  }

  function fmtRemaining(ms) {
    if (ms <= 0) return null;
    const totalSec = Math.floor(ms / 1000);
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function tickCountdown() {
    if (!status) return;
    const now = Date.now() + clockOffsetMs;
    let target = null;
    let prefix = '';
    if (status.phase === 'before') {
      target = new Date(status.eventStart).getTime();
      prefix = 'Starts in ';
    } else if (status.phase === 'upload') {
      target = new Date(status.eventEnd).getTime();
      prefix = 'Uploads close in ';
    } else if (status.phase === 'voting') {
      target = new Date(status.votingEnd).getTime();
      prefix = 'Voting closes in ';
    }
    const cd = el('countdown');
    if (!target) {
      cd.textContent = '';
      return;
    }
    const remaining = fmtRemaining(target - now);
    if (remaining === null) {
      cd.textContent = 'Updating…';
      refreshStatus(); // phase boundary crossed, refetch
    } else {
      cd.textContent = prefix + remaining;
    }
  }

  async function refreshStatus() {
    if (!SLUG) {
      showScreen('unconfigured');
      el('phaseLabel').textContent = 'Invalid link';
      document.querySelector('#screen-unconfigured .lede').textContent =
        "This doesn't look like a valid event link. Ask your host for the link they shared.";
      return;
    }
    const before = Date.now();
    const res = await fetch(`${API}/status`);
    if (res.status === 404) {
      showScreen('unconfigured');
      el('phaseLabel').textContent = 'Not found';
      document.querySelector('#screen-unconfigured .lede').textContent =
        "This event link is invalid or the event no longer exists. Ask your host for a current link.";
      return;
    }
    const data = await res.json();
    const after = Date.now();
    clockOffsetMs = new Date(data.serverNow).getTime() - Math.round((before + after) / 2);
    status = data;
    if (data.eventName) {
      document.title = data.eventName;
      el('eventTitle').textContent = data.eventName;
    }
    setPhaseChip(status.phase);
    if (!el('infoPanel').classList.contains('hidden')) renderInfoPanel();
    render();
  }

  // ---------- "What is this?" (join screen) ----------

  const fmtWhen = (iso) =>
    new Date(iso).toLocaleString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short', // guests can be in different time zones, so always say which
    });

  function fmtHours(h) {
    const n = Number(h);
    return `${n} hour${n === 1 ? '' : 's'}`;
  }

  // Explains the contest and gives the real dates, all taken from what the
  // host set (start, end, voting length -- via the status the server sends).
  // Wording follows where the event is right now ("opens" / "is open now" /
  // "closed"). Built from text nodes, not innerHTML.
  function renderInfoPanel() {
    const panel = el('infoPanel');
    panel.innerHTML = '';
    if (!status) return;

    const phase = status.phase;
    // The join screen (and so this panel) only appears once the host has set a
    // schedule -- unscheduled events show "Getting set up" instead -- so the dates
    // are normally always there; the guard just keeps this from ever printing "undefined".
    const configured = phase !== 'not_configured' && status.eventStart && status.eventEnd && status.votingEnd;

    const intro = document.createElement('p');
    intro.textContent =
      'Everyone shares photos from the event, then everyone votes for their favorites. The most-liked photo wins.';
    panel.appendChild(intro);

    const when = {};
    if (configured) {
      const start = fmtWhen(status.eventStart);
      const end = fmtWhen(status.eventEnd);
      const votingEnd = fmtWhen(status.votingEnd);
      const length = status.votingHours ? ` (${fmtHours(status.votingHours)} of voting)` : '';

      when.upload =
        phase === 'before'
          ? `Uploads open ${start} and close ${end}.`
          : phase === 'upload'
            ? `Uploads are open now and close ${end}.`
            : `Uploads closed ${end}.`;
      when.vote =
        phase === 'before' || phase === 'upload'
          ? `Voting opens ${end} and closes ${votingEnd}${length}.`
          : phase === 'voting'
            ? `Voting is open now and closes ${votingEnd}.`
            : `Voting closed ${votingEnd}.`;
      when.results = phase === 'results' ? 'Results are in.' : `Results are revealed ${votingEnd}.`;
    }

    const steps = [
      {
        title: 'Join.',
        detail:
          'Pick a name and a 4-digit PIN on this screen. The PIN lets you get back into your name later, and stops anyone else from voting as you.',
      },
      {
        title: 'Submit your photos.',
        detail: 'Upload as many photos as you like. You can delete your own while uploads are open.',
        when: when.upload,
      },
      {
        title: 'Vote.',
        detail:
          'Once uploads close, everyone sees all the photos (no names, no like counts) and taps ♥ on their favorites. Like as many as you want, once each.',
        when: when.vote,
      },
      {
        title: 'See the results.',
        detail:
          'The most-liked photo wins. If photos tie, it goes to whoever has the most total likes across all their photos, then the most photos uploaded. Everyone can save the photos afterward.',
        when: when.results,
      },
    ];

    const list = document.createElement('ol');
    steps.forEach((step) => {
      const li = document.createElement('li');
      const strong = document.createElement('strong');
      strong.textContent = step.title;
      const detail = document.createElement('span');
      detail.className = 'info-detail';
      detail.textContent = ` ${step.detail}`;
      li.append(strong, detail);
      if (step.when) {
        const w = document.createElement('span');
        w.className = 'info-when';
        w.textContent = step.when;
        li.appendChild(w);
      }
      list.appendChild(li);
    });
    panel.appendChild(list);
  }

  async function loadUsers() {
    const res = await fetch(`${API}/users`);
    const data = await res.json();
    usersList = data.users || [];
  }

  function renderWhoRow() {
    const row = el('whoRow');
    if (username) {
      row.classList.remove('hidden');
      el('whoName').textContent = username;
    } else {
      row.classList.add('hidden');
    }
  }

  function showLoginBlocks() {
    el('resumeBlock').classList.add('hidden');
    el('newUserBlock').classList.remove('hidden');
  }

  function showResumePrompt(name) {
    el('resumeUserLabel').textContent = name;
    el('resumeForm').dataset.username = name;
    el('resumeMsg').innerHTML = '';
    el('resumePinInput').value = '';
    el('newUserBlock').classList.add('hidden');
    el('resumeBlock').classList.remove('hidden');
    el('resumePinInput').focus();
  }

  function renderExistingUsers() {
    const grid = el('existingUsersGrid');
    grid.innerHTML = '';
    el('noExistingUsers').classList.toggle('hidden', usersList.length > 0);
    usersList.forEach((u) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'user-pick';
      btn.textContent = u;
      btn.addEventListener('click', () => {
        const cached = getCachedToken(u);
        if (cached) {
          // This device has already proven it owns this name -- resume instantly.
          username = u;
          guestToken = cached;
          localStorage.setItem(STORAGE_KEY, u);
          render();
        } else {
          // A different device (or a different guest) claiming this name --
          // this is exactly the case the PIN exists to gate.
          showResumePrompt(u);
        }
      });
      grid.appendChild(btn);
    });
  }

  function showLoginError(msg) {
    el('loginMsg').innerHTML = `<div class="error-msg">${msg}</div>`;
  }
  function clearLoginMsg() {
    el('loginMsg').innerHTML = '';
  }

  async function handleLoginSubmit(e) {
    e.preventDefault();
    const nameInput = el('usernameInput');
    const pinInput = el('pinInput');
    const name = nameInput.value.trim();
    const pin = pinInput.value.trim();
    clearLoginMsg();
    if (!name || !pin) return;

    const submitBtn = el('loginSubmitBtn');
    submitBtn.disabled = true;
    try {
      const res = await fetch(`${API}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name, pin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not join right now.');
      username = data.username;
      guestToken = data.token;
      localStorage.setItem(STORAGE_KEY, username);
      setCachedToken(username, guestToken);
      nameInput.value = '';
      pinInput.value = '';
      await render();
    } catch (err) {
      showLoginError(err.message);
    } finally {
      submitBtn.disabled = false;
    }
  }

  async function handleResumeSubmit(e) {
    e.preventDefault();
    const name = el('resumeForm').dataset.username;
    const pin = el('resumePinInput').value.trim();
    const msg = el('resumeMsg');
    msg.innerHTML = '';
    if (!pin) return;

    const submitBtn = el('resumeSubmitBtn');
    submitBtn.disabled = true;
    try {
      const res = await fetch(`${API}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name, pin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not sign in.');
      username = data.username;
      guestToken = data.token;
      localStorage.setItem(STORAGE_KEY, username);
      setCachedToken(username, guestToken);
      showLoginBlocks();
      await render();
    } catch (err) {
      msg.innerHTML = `<div class="error-msg">${err.message}</div>`;
    } finally {
      submitBtn.disabled = false;
    }
  }

  async function render() {
    renderWhoRow();

    if (!status || status.phase === 'not_configured') {
      showScreen('unconfigured');
      return;
    }

    await loadUsers();

    // A username with no matching token can't actually do anything (every
    // authenticated call would just 401) -- treat it as logged out rather
    // than showing screens the person can't use.
    if (username && !guestToken) {
      username = null;
      localStorage.removeItem(STORAGE_KEY);
    }

    if (!username) {
      showLoginBlocks();
      renderExistingUsers();
      showScreen('login');
      return;
    }

    // If this username is no longer registered (e.g. a host removed it), log out.
    if (!usersList.includes(username)) {
      username = null;
      guestToken = null;
      localStorage.removeItem(STORAGE_KEY);
      showLoginBlocks();
      renderExistingUsers();
      showScreen('login');
      return;
    }

    if (status.phase === 'before') {
      showScreen('before');
    } else if (status.phase === 'upload') {
      showScreen('upload');
      await renderMyUploads();
      await renderFeatured();
    } else if (status.phase === 'voting') {
      showScreen('voting');
      await renderVoting();
    } else if (status.phase === 'results') {
      showScreen('results');
      await renderResults();
    }
  }

  // Shrinks and re-encodes a photo to a normal JPEG before it's uploaded.
  // This sidesteps the two things that most often break phone uploads on
  // flaky event wifi: very large files (modern phones can produce 10-25MB
  // photos) and format quirks like HEIC. If anything here fails for any
  // reason, we fall back to uploading the original file untouched.
  const MAX_UPLOAD_DIMENSION = 2000;
  const JPEG_QUALITY = 0.85;

  function loadAsImageElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not read image'));
      };
      img.src = url;
    });
  }

  // Races a promise against a timeout. If the promise doesn't settle in
  // time, or it rejects, we resolve with fallbackValue instead of leaving
  // the caller hanging. iOS Safari has a known issue where canvas.toBlob()
  // can silently never call its callback under memory pressure (e.g. a
  // very large photo), so without this a stuck resize would hang the
  // upload forever with no error and no way forward.
  function withFallback(promise, ms, fallbackValue) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          console.warn(`Photo prep took longer than ${ms}ms, using the original file instead.`);
          resolve(fallbackValue);
        }
      }, ms);
      promise.then(
        (result) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(result);
          }
        },
        (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            console.warn('Falling back to the original photo file for upload:', err);
            resolve(fallbackValue);
          }
        }
      );
    });
  }

  async function prepareImageForUpload(file) {
    let bitmap = null;
    let objectUrl = null;
    try {
      let width;
      let height;
      let drawSource;

      if (typeof createImageBitmap === 'function') {
        bitmap = await createImageBitmap(file);
        drawSource = bitmap;
        width = bitmap.width;
        height = bitmap.height;
      } else {
        const { img, url } = await loadAsImageElement(file);
        objectUrl = url;
        drawSource = img;
        width = img.naturalWidth;
        height = img.naturalHeight;
      }

      if (!width || !height) throw new Error('Image had no dimensions');

      if (width > MAX_UPLOAD_DIMENSION || height > MAX_UPLOAD_DIMENSION) {
        const scale = MAX_UPLOAD_DIMENSION / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(drawSource, 0, 0, width, height);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
      if (!blob) throw new Error('Canvas produced no image data');

      const baseName = (file.name || 'photo').replace(/\.[^.]+$/, '');
      return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
    } catch (err) {
      console.warn('Falling back to the original photo file for upload:', err);
      return file;
    } finally {
      if (bitmap && bitmap.close) bitmap.close();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  // ---------- Upload screen ----------

  async function renderMyUploads() {
    const res = await fetch(`${API}/photos`, { headers: { Authorization: `Bearer ${guestToken}` } });
    const data = await res.json();
    const mine = data.photos.filter((p) => p.mine); // the server says which are mine; it no longer sends names
    el('mineCount').textContent = mine.length;
    const grid = el('mineGrid');
    grid.innerHTML = '';
    el('mineEmpty').classList.toggle('hidden', mine.length > 0);
    mine.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'thumb';
      div.style.position = 'relative';
      div.innerHTML = `
        <img src="${p.url}" alt="Your photo" loading="lazy" />
        <button type="button" data-id="${p.id}" title="Delete this photo"
          style="position:absolute; top:4px; right:4px; background:rgba(18,19,42,0.85); border:1px solid var(--coral); color:var(--coral); border-radius:6px; font-size:11px; padding:3px 6px; cursor:pointer;">
          Delete
        </button>`;
      grid.appendChild(div);
    });

    grid.querySelectorAll('button[data-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this photo? This cannot be undone.')) return;
        btn.disabled = true;
        try {
          const delRes = await fetch(`${API}/photos/${btn.dataset.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${guestToken}` },
          });
          const delData = await delRes.json().catch(() => ({}));
          if (!delRes.ok) throw new Error(delData.error || 'Could not delete photo.');
          await renderMyUploads();
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
        }
      });
    });
  }

  // The "sneak peek": one photo from the album, rotated hourly by the server.
  // No uploader name is shown, same as the voting screen.
  let currentFeaturedId = null;

  async function renderFeatured() {
    const card = el('featuredCard');
    try {
      const res = await fetch(`${API}/featured`);
      if (!res.ok) throw new Error('featured unavailable');
      const data = await res.json();
      if (!data.photo) {
        card.classList.add('hidden');
        currentFeaturedId = null;
        return;
      }
      if (data.photo.id !== currentFeaturedId) {
        el('featuredImg').src = data.photo.url;
        currentFeaturedId = data.photo.id;
      }
      const when = data.nextChangeAt
        ? new Date(data.nextChangeAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : null;
      el('featuredNote').textContent = when
        ? `A new photo is featured every hour, on the hour. Next one at ${when}.`
        : 'A new photo is featured every hour, on the hour.';
      card.classList.remove('hidden');
    } catch (_) {
      card.classList.add('hidden'); // a missing preview should never get in the way of uploading
    }
  }

  const UPLOAD_TIMEOUT_MS = 45000;

  // Photos go up one at a time from a queue. One-at-a-time keeps memory low on
  // phones (each photo is decoded and resized before sending) and means a flaky
  // connection only ever costs you the photo that was in flight. Picking more
  // photos while an upload is running just adds them to the same queue.
  const uploadQueue = [];
  let uploadRunning = false;
  let batchTotal = 0;
  let batchSucceeded = 0;
  let batchFailed = []; // { file, message }

  async function uploadOne(preparedFile) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const form = new FormData();
      form.append('photo', preparedFile);
      const res = await fetch(`${API}/upload`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${guestToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || 'Upload failed.');
        // 401/403 = signed out or uploads closed: every other photo would fail the same way.
        err.fatal = res.status === 401 || res.status === 403;
        throw err;
      }
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Upload timed out — the connection may be slow.');
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function enqueueFiles(files) {
    if (files.length === 0) return;
    if (!uploadRunning) {
      batchTotal = 0;
      batchSucceeded = 0;
      batchFailed = [];
    }
    files.forEach((f) => uploadQueue.push(f));
    batchTotal += files.length;
    if (!uploadRunning) processUploadQueue();
  }

  async function processUploadQueue() {
    uploadRunning = true;
    const msg = el('uploadMsg');
    while (uploadQueue.length > 0) {
      const file = uploadQueue.shift();
      const position = batchSucceeded + batchFailed.length + 1;
      const counter = batchTotal > 1 ? ` ${position} of ${batchTotal}` : '';
      msg.innerHTML = `<p class="lede">Preparing photo${counter}…</p>`;

      let uploaded = false;
      try {
        // 8s is generous for resizing a phone photo; if it's not done by then
        // something's stuck (see withFallback) and we upload the original as-is.
        const prepared = await withFallback(prepareImageForUpload(file), 8000, file);
        msg.innerHTML = `<p class="lede">Uploading photo${counter}…</p>`;
        await uploadOne(prepared);
        uploaded = true;
      } catch (err) {
        const message = err.message || 'Upload failed.';
        batchFailed.push({ file, message });
        if (err.fatal) {
          while (uploadQueue.length > 0) batchFailed.push({ file: uploadQueue.shift(), message });
        }
      }

      if (uploaded) {
        batchSucceeded += 1;
        try {
          await renderMyUploads(); // thumbnails appear as each photo lands
        } catch (_) {
          /* the upload itself worked; a failed refresh isn't an upload failure */
        }
      }
    }
    uploadRunning = false;
    el('fileInput').value = ''; // lets the same photos be picked again later
    showBatchSummary();
  }

  function showBatchSummary() {
    const msg = el('uploadMsg');
    msg.innerHTML = '';

    if (batchFailed.length === 0) {
      const ok = document.createElement('div');
      ok.className = 'success-msg';
      ok.textContent = batchSucceeded === 1 ? 'Photo uploaded!' : `${batchSucceeded} photos uploaded!`;
      msg.appendChild(ok);
      setTimeout(() => {
        if (!uploadRunning && msg.firstChild === ok) msg.innerHTML = '';
      }, 3000);
      return;
    }

    const failedCount = batchFailed.length;
    const lead =
      batchSucceeded > 0
        ? `${batchSucceeded} uploaded, but ${failedCount} didn't make it.`
        : failedCount === 1
          ? "That photo didn't upload."
          : `${failedCount} photos didn't upload.`;
    const err = document.createElement('div');
    err.className = 'error-msg';
    err.textContent = `${lead} ${batchFailed[0].message}`;
    msg.appendChild(err);

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'btn btn-ghost btn-block';
    retryBtn.style.marginTop = '10px';
    retryBtn.textContent = failedCount === 1 ? 'Try again' : `Try the ${failedCount} again`;
    retryBtn.addEventListener('click', () => enqueueFiles(batchFailed.map((f) => f.file)));
    msg.appendChild(retryBtn);
  }

  function wireUpload() {
    const input = el('fileInput');
    // The upload area is a <label for="fileInput">, which already opens the
    // native photo picker on tap with no JS needed. Do NOT also call
    // input.click() here -- doing both was firing the picker twice per tap,
    // and on iOS Safari that double-trigger can wipe out the just-picked
    // file before the change handler ever sees it (the exact bug reported:
    // pick a photo, confirm, and nothing happens with no error).
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      if (files.length === 0) return;
      enqueueFiles(files);
    });
  }

  // ---------- Voting screen ----------

  let voteOrder = null; // shuffled photo ids, fixed per session so the grid doesn't jump

  async function renderVoting() {
    const res = await fetch(`${API}/photos`, { headers: { Authorization: `Bearer ${guestToken}` } });
    const data = await res.json();
    let photos = data.photos;

    if (!voteOrder) {
      voteOrder = photos.map((p) => p.id);
      for (let i = voteOrder.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [voteOrder[i], voteOrder[j]] = [voteOrder[j], voteOrder[i]];
      }
    }
    const byId = Object.fromEntries(photos.map((p) => [p.id, p]));
    photos = voteOrder.map((id) => byId[id]).filter(Boolean);

    el('voteEmpty').classList.toggle('hidden', photos.length > 0);
    const grid = el('voteGrid');
    grid.innerHTML = '';
    photos.forEach((p) => {
      const card = document.createElement('div');
      card.className = 'photo-card';
      card.innerHTML = `
        <img class="ph-img" src="${p.url}" alt="Contest photo" loading="lazy" />
        <div class="ph-meta ph-meta-end">
          <button class="like-btn ${p.likedByMe ? 'liked' : ''}" data-id="${p.id}">
            <span class="heart">${p.likedByMe ? '♥' : '♡'}</span>
          </button>
        </div>`;
      grid.appendChild(card);

      card.querySelector('.ph-img').addEventListener('click', () => openLightbox(p.url));
    });

    grid.querySelectorAll('.like-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const res = await fetch(`${API}/like`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${guestToken}` },
            body: JSON.stringify({ photoId: btn.dataset.id }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Could not like photo.');
          await renderVoting();
        } catch (err) {
          alert(err.message);
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  // ---------- Results screen ----------

  let selectedIds = new Set();
  let resultsPhotos = [];

  function updateDownloadSelectedButton() {
    const btn = el('downloadSelectedBtn');
    el('selectedCount').textContent = selectedIds.size;
    btn.classList.toggle('hidden', selectedIds.size === 0);
  }

  // Above this many photos we skip straight to the zip fallback -- fetching
  // and holding that many full-size images as blobs in memory to hand to
  // the share sheet gets slow and unreliable, and some OS share sheets cap
  // how many files they'll accept at once anyway.
  const SHARE_PHOTO_LIMIT = 30;

  function extensionFromUrl(url) {
    const clean = url.split('?')[0];
    const dot = clean.lastIndexOf('.');
    return dot === -1 ? 'jpg' : clean.slice(dot + 1);
  }

  function zipUrlFor(ids) {
    return ids ? `${API}/download?ids=${encodeURIComponent(ids.join(','))}` : `${API}/download`;
  }

  // Tries the native share sheet (which offers "Save Image(s)" straight to
  // the phone's gallery on most modern iOS/Android browsers). Falls back to
  // the zip download wherever that isn't available or doesn't work.
  async function saveOrDownload(button, ids) {
    const photos = ids ? resultsPhotos.filter((p) => ids.includes(p.id)) : resultsPhotos;
    if (photos.length === 0) return;

    const canTryShare =
      photos.length <= SHARE_PHOTO_LIMIT &&
      typeof navigator.share === 'function' &&
      typeof navigator.canShare === 'function';

    if (canTryShare) {
      const originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = 'Preparing…';
      try {
        const files = await Promise.all(
          photos.map(async (p, i) => {
            const fileRes = await fetch(p.url);
            const blob = await fileRes.blob();
            return new File([blob], `photo-${i + 1}.${extensionFromUrl(p.url)}`, {
              type: blob.type || 'image/jpeg',
            });
          })
        );
        if (navigator.canShare({ files })) {
          await navigator.share({ files, title: 'Event photos' });
          return; // shared (or the user cancelled the share sheet) -- either way, done
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return; // user backed out of the share sheet on purpose
        // Otherwise fall through to the zip download below.
      } finally {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    }

    window.location.href = zipUrlFor(ids);
  }

  function formatNames(names) {
    if (names.length <= 1) return names[0] || '';
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // Explains who won and, if it took a tiebreaker, exactly how it was decided.
  // Built from text nodes (not innerHTML) because usernames are guest-chosen.
  function renderWinnerBanner(winner) {
    const box = el('winnerBanner');
    box.innerHTML = '';
    if (!winner) {
      box.classList.add('hidden');
      return;
    }
    const line = document.createElement('div');
    const addText = (t) => line.appendChild(document.createTextNode(t));
    const addName = (t) => {
      const strong = document.createElement('strong');
      strong.textContent = t;
      line.appendChild(strong);
    };
    const sub = document.createElement('span');
    sub.className = 'banner-sub';

    if (winner.decidedBy === 'tie') {
      addText("It's a tie! ");
      addName(formatNames(winner.users));
      addText(' share the win.');
      sub.textContent =
        `All level on ${plural(winner.likeCount, 'like')} for their top photo, ` +
        `${plural(winner.totalLikes, 'like')} across all their photos, ` +
        `and ${plural(winner.photoCount, 'photo')} uploaded.`;
    } else if (winner.decidedBy === 'total_likes') {
      addName(winner.users[0]);
      addText(' wins!');
      sub.textContent =
        `The top photos tied at ${plural(winner.likeCount, 'like')}, so the tiebreaker went to the ` +
        `uploader with the most total likes across all their photos (${winner.totalLikes}).`;
    } else if (winner.decidedBy === 'photo_count') {
      addName(winner.users[0]);
      addText(' wins!');
      sub.textContent =
        `The top photos tied at ${plural(winner.likeCount, 'like')} and the uploaders tied on total likes ` +
        `(${winner.totalLikes}), so the win goes to whoever uploaded the most photos (${winner.photoCount}).`;
    } else {
      addName(winner.users[0]);
      addText(` wins with the most-liked photo — ${plural(winner.likeCount, 'like')}.`);
    }

    box.appendChild(line);
    if (sub.textContent) box.appendChild(sub);
    box.classList.remove('hidden');
  }

  async function renderResults() {
    const res = await fetch(`${API}/results`);
    if (!res.ok) return; // results aren't open yet (e.g. clocks a moment out of step); next poll retries
    const data = await res.json();
    resultsPhotos = data.all;

    renderWinnerBanner(data.winner);

    const podium = el('podium');
    podium.innerHTML = '';
    const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
    // Tied ranks (e.g. two golds, no silver) don't fit the classic 2-1-3 arrangement.
    podium.classList.toggle('flat', data.top.some((p) => p.rankShared > 1));
    data.top.forEach((p) => {
      const slot = document.createElement('div');
      slot.className = `slot rank${p.rank}`;
      const img = document.createElement('img');
      img.src = p.url;
      img.alt = `Photo by ${p.username}`;
      const medal = document.createElement('div');
      medal.className = 'rank-label';
      medal.textContent = medals[p.rank] || '';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = p.username;
      const count = document.createElement('div');
      count.className = 'count';
      count.textContent = plural(p.likeCount, 'like');
      slot.append(img, medal, name, count);
      podium.appendChild(slot);
    });
    if (data.top.length === 0) {
      podium.innerHTML = '<p class="empty" style="grid-column: 1 / -1;">No photos were uploaded during the event.</p>';
    }
    const overflow = el('podiumOverflow');
    if (data.topOverflow > 0) {
      overflow.textContent = `…and ${plural(data.topOverflow, 'more photo')} tied for the podium. See the full album below.`;
      overflow.classList.remove('hidden');
    } else {
      overflow.classList.add('hidden');
    }
    el('downloadAllBtn').classList.toggle('hidden', data.all.length === 0);

    // Drop any selected ids for photos that no longer exist (e.g. admin moderation).
    const stillThere = new Set(data.all.map((p) => p.id));
    selectedIds = new Set([...selectedIds].filter((id) => stillThere.has(id)));

    const grid = el('resultsGrid');
    grid.innerHTML = '';
    data.all.forEach((p) => {
      const card = document.createElement('div');
      card.className = 'result-card' + (selectedIds.has(p.id) ? ' selected' : '');

      const wrap = document.createElement('div');
      wrap.className = 'thumb-wrap';
      const img = document.createElement('img');
      img.src = p.url;
      img.alt = `Photo by ${p.username}`;
      img.loading = 'lazy';
      const check = document.createElement('span');
      check.className = 'select-check';
      const mark = document.createElement('span');
      mark.className = 'checkmark';
      mark.textContent = '✓';
      check.appendChild(mark);
      wrap.append(img, check);

      const caption = document.createElement('div');
      caption.className = 'caption';
      const who = document.createElement('span');
      // "T1" = tied for 1st, the usual shorthand for shared ranks.
      who.textContent = `${p.rankShared > 1 ? 'T' : '#'}${p.rank} · ${p.username}`;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `${p.likeCount} ♥`;
      caption.append(who, count);

      card.append(wrap, caption);
      card.addEventListener('click', () => {
        if (selectedIds.has(p.id)) selectedIds.delete(p.id);
        else selectedIds.add(p.id);
        card.classList.toggle('selected');
        updateDownloadSelectedButton();
      });
      grid.appendChild(card);
    });

    updateDownloadSelectedButton();
  }

  // ---------- Lightbox ----------

  function openLightbox(url) {
    el('lightboxImg').src = url;
    el('lightbox').classList.remove('hidden');
  }

  function closeLightbox() {
    el('lightbox').classList.add('hidden');
    el('lightboxImg').src = '';
  }

  el('lightboxClose').addEventListener('click', closeLightbox);
  el('lightbox').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeLightbox(); // ignore clicks on the image itself
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
  });

  // ---------- Init ----------

  el('whatIsThisBtn').addEventListener('click', () => {
    const panel = el('infoPanel');
    const opening = panel.classList.contains('hidden');
    if (opening) renderInfoPanel();
    panel.classList.toggle('hidden', !opening);
    el('whatIsThisBtn').setAttribute('aria-expanded', String(opening));
    el('whatIsThisBtn').textContent = opening ? 'Hide' : 'What is this?';
  });

  el('loginForm').addEventListener('submit', handleLoginSubmit);
  el('resumeForm').addEventListener('submit', handleResumeSubmit);
  el('resumeCancelBtn').addEventListener('click', () => {
    showLoginBlocks();
    render();
  });

  el('switchUserBtn').addEventListener('click', () => {
    username = null;
    guestToken = null;
    localStorage.removeItem(STORAGE_KEY);
    voteOrder = null;
    selectedIds = new Set();
    el('usernameInput').value = '';
    el('pinInput').value = '';
    clearLoginMsg();
    showLoginBlocks();
    render();
  });

  el('downloadAllBtn').addEventListener('click', (e) => {
    saveOrDownload(e.currentTarget, null);
  });

  el('downloadSelectedBtn').addEventListener('click', (e) => {
    if (selectedIds.size === 0) return;
    saveOrDownload(e.currentTarget, [...selectedIds]);
  });

  wireUpload();
  el('featuredImg').addEventListener('click', () => openLightbox(el('featuredImg').src));

  refreshStatus();
  pollTimer = setInterval(refreshStatus, 20000);
  countdownTimer = setInterval(tickCountdown, 1000);
})();
