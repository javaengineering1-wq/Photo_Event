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

  function renderLogin() {
    const grid = el('userGrid');
    grid.innerHTML = '';
    el('noUsers').classList.toggle('hidden', usersList.length > 0);
    usersList.forEach((u) => {
      const btn = document.createElement('button');
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

  async function render() {
    renderWhoRow();

    if (!status || status.phase === 'not_configured') {
      showScreen('unconfigured');
      return;
    }

    if (!username) {
      await loadUsers();
      renderLogin();
      showScreen('login');
      return;
    }

    // If the saved username is no longer on the admin's list, log out.
    if (usersList.length === 0) await loadUsers();
    if (!usersList.includes(username)) {
      username = null;
      localStorage.removeItem(STORAGE_KEY);
      await loadUsers();
      renderLogin();
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

  function wireUpload() {
    const input = el('fileInput');
    const zone = el('dropzone');
    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const msg = el('uploadMsg');
      msg.innerHTML = '<p class="lede">Uploading…</p>';
      try {
        const form = new FormData();
        form.append('username', username);
        form.append('photo', file);
        const res = await fetch('/api/upload', { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed.');
        msg.innerHTML = '<div class="success-msg">Photo uploaded!</div>';
        input.value = '';
        await renderMyUploads();
        setTimeout(() => { msg.innerHTML = ''; }, 2500);
      } catch (err) {
        msg.innerHTML = `<div class="error-msg">${err.message}</div>`;
      }
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

  el('switchUserBtn').addEventListener('click', () => {
    username = null;
    localStorage.removeItem(STORAGE_KEY);
    voteOrder = null;
    selectedIds = new Set();
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
