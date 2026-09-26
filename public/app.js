(() => {
  const STORAGE_KEY = 'photocontest.username';

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
  let username = localStorage.getItem(STORAGE_KEY) || null;
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
    const before = Date.now();
    const res = await fetch('/api/status');
    const data = await res.json();
    const after = Date.now();
    clockOffsetMs = new Date(data.serverNow).getTime() - Math.round((before + after) / 2);
    status = data;
    setPhaseChip(status.phase);
    render();
  }

  async function loadUsers() {
    const res = await fetch('/api/users');
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
        username = u;
        localStorage.setItem(STORAGE_KEY, u);
        render();
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
    const input = el('usernameInput');
    const name = input.value.trim();
    clearLoginMsg();
    if (!name) return;

    const submitBtn = el('loginSubmitBtn');
    submitBtn.disabled = true;
    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not join right now.');
      username = data.username;
      localStorage.setItem(STORAGE_KEY, username);
      input.value = '';
      await render();
    } catch (err) {
      showLoginError(err.message);
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

    if (!username) {
      renderExistingUsers();
      showScreen('login');
      return;
    }

    // If this username is no longer registered (e.g. an admin removed it), log out.
    if (!usersList.includes(username)) {
      username = null;
      localStorage.removeItem(STORAGE_KEY);
      renderExistingUsers();
      showScreen('login');
      return;
    }

    if (status.phase === 'before') {
      showScreen('before');
    } else if (status.phase === 'upload') {
      showScreen('upload');
      await renderMyUploads();
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
    const res = await fetch('/api/photos?username=' + encodeURIComponent(username));
    const data = await res.json();
    const mine = data.photos.filter((p) => p.username === username);
    el('mineCount').textContent = mine.length;
    const grid = el('mineGrid');
    grid.innerHTML = '';
    el('mineEmpty').classList.toggle('hidden', mine.length > 0);
    mine.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'thumb';
      div.innerHTML = `<img src="${p.url}" alt="Your photo" loading="lazy" />`;
      grid.appendChild(div);
    });
  }

  const UPLOAD_TIMEOUT_MS = 45000;

  async function performUpload(originalFile) {
    const msg = el('uploadMsg');
    msg.innerHTML = '<p class="lede">Preparing photo…</p>';

    // 8s is generous for resizing a phone photo; if it's not done by then,
    // something's stuck (see withFallback above) and we upload as-is instead.
    const preparedFile = await withFallback(prepareImageForUpload(originalFile), 8000, originalFile);

    msg.innerHTML = '<p class="lede">Uploading…</p>';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

    try {
      const form = new FormData();
      form.append('username', username);
      form.append('photo', preparedFile);
      const res = await fetch('/api/upload', { method: 'POST', body: form, signal: controller.signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed.');
      msg.innerHTML = '<div class="success-msg">Photo uploaded!</div>';
      el('fileInput').value = '';
      await renderMyUploads();
      setTimeout(() => { msg.innerHTML = ''; }, 2500);
    } catch (err) {
      const timedOut = err.name === 'AbortError';
      const errorText = timedOut
        ? 'Upload timed out — the connection may be slow. Try again?'
        : `${err.message || 'Upload failed.'} Try again?`;
      msg.innerHTML = `<div class="error-msg">${errorText}</div>`;
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn btn-ghost btn-block';
      retryBtn.style.marginTop = '10px';
      retryBtn.textContent = 'Try again';
      retryBtn.addEventListener('click', () => performUpload(originalFile));
      msg.appendChild(retryBtn);
    } finally {
      clearTimeout(timeoutId);
    }
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
      const file = input.files[0];
      if (!file) return;
      performUpload(file);
    });
  }

  // ---------- Voting screen ----------

  let voteOrder = null; // shuffled photo ids, fixed per session so the grid doesn't jump

  async function renderVoting() {
    const res = await fetch('/api/photos?username=' + encodeURIComponent(username));
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
          const res = await fetch('/api/like', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, photoId: btn.dataset.id }),
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
    return ids ? `/api/download?ids=${encodeURIComponent(ids.join(','))}` : '/api/download';
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

  async function renderResults() {
    const res = await fetch('/api/results');
    const data = await res.json();
    resultsPhotos = data.all;

    const podium = el('podium');
    podium.innerHTML = '';
    const ranks = ['rank1', 'rank2', 'rank3'];
    const medals = ['🥇', '🥈', '🥉'];
    data.top.forEach((p, i) => {
      const slot = document.createElement('div');
      slot.className = `slot ${ranks[i]}`;
      slot.innerHTML = `
        <img src="${p.url}" alt="Photo by ${p.username}" />
        <div class="rank-label">${medals[i]}</div>
        <div class="name">${p.username}</div>
        <div class="count">${p.likeCount} like${p.likeCount === 1 ? '' : 's'}</div>`;
      podium.appendChild(slot);
    });
    if (data.top.length === 0) {
      podium.innerHTML = '<p class="empty" style="grid-column: 1 / -1;">No photos were uploaded during the event.</p>';
    }
    el('downloadAllBtn').classList.toggle('hidden', data.all.length === 0);

    // Drop any selected ids for photos that no longer exist (e.g. admin moderation).
    const stillThere = new Set(data.all.map((p) => p.id));
    selectedIds = new Set([...selectedIds].filter((id) => stillThere.has(id)));

    const grid = el('resultsGrid');
    grid.innerHTML = '';
    data.all.forEach((p, i) => {
      const card = document.createElement('div');
      card.className = 'result-card' + (selectedIds.has(p.id) ? ' selected' : '');
      card.innerHTML = `
        <div class="thumb-wrap">
          <img src="${p.url}" alt="Photo by ${p.username}" loading="lazy" />
          <span class="select-check"><span class="checkmark">✓</span></span>
        </div>
        <div class="caption">
          <span>#${i + 1} · ${p.username}</span>
          <span class="count">${p.likeCount} ♥</span>
        </div>`;
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

  el('loginForm').addEventListener('submit', handleLoginSubmit);

  el('switchUserBtn').addEventListener('click', () => {
    username = null;
    localStorage.removeItem(STORAGE_KEY);
    voteOrder = null;
    selectedIds = new Set();
    el('usernameInput').value = '';
    clearLoginMsg();
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

  refreshStatus();
  pollTimer = setInterval(refreshStatus, 20000);
  countdownTimer = setInterval(tickCountdown, 1000);
})();
