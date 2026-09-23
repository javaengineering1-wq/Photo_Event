(() => {
  const el = (id) => document.getElementById(id);
  const SESSION_KEY = 'photocontest.adminKey';
  let adminKey = sessionStorage.getItem(SESSION_KEY) || null;

  function toLocalInputValue(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        'x-admin-key': adminKey || '',
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function tryUnlock(password) {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Incorrect password.');
    }
    adminKey = password;
    sessionStorage.setItem(SESSION_KEY, password);
  }

  async function loadConfig() {
    const data = await api('/api/admin/config');
    el('eventStart').value = toLocalInputValue(data.config.eventStart);
    el('eventEnd').value = toLocalInputValue(data.config.eventEnd);
    el('votingHours').value = data.config.votingHours || 24;
    el('usernames').value = data.users.join('\n');

    const status = await fetch('/api/status').then((r) => r.json());
    const phaseNames = {
      not_configured: 'Not configured yet.',
      before: 'Waiting for the event to start.',
      upload: 'Uploads are currently open.',
      voting: 'Voting is currently open.',
      results: 'Results are final.',
    };
    el('currentPhaseInfo').textContent = 'Current phase: ' + (phaseNames[status.phase] || status.phase);
  }

  async function loadPhotos() {
    const data = await api('/api/admin/config'); // ensures auth still valid
    const photosRes = await fetch('/api/photos').then((r) => r.json());
    const grid = el('modGrid');
    grid.innerHTML = '';
    el('modEmpty').classList.toggle('hidden', photosRes.photos.length > 0);
    photosRes.photos.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'thumb';
      div.style.position = 'relative';
      div.innerHTML = `
        <img src="${p.url}" alt="Photo by ${p.username}" loading="lazy" />
        <button data-id="${p.id}" title="Delete photo"
          style="position:absolute; top:4px; right:4px; background:rgba(18,19,42,0.85); border:1px solid var(--coral); color:var(--coral); border-radius:6px; font-size:11px; padding:3px 6px; cursor:pointer;">
          Delete
        </button>`;
      grid.appendChild(div);
    });
    grid.querySelectorAll('button[data-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this photo and its likes?')) return;
        await api(`/api/admin/photos/${btn.dataset.id}`, { method: 'DELETE' });
        await loadPhotos();
      });
    });
  }

  el('loginBtn').addEventListener('click', async () => {
    const pw = el('pw').value;
    const msg = el('lockMsg');
    msg.innerHTML = '';
    try {
      await tryUnlock(pw);
      el('screen-lock').classList.add('hidden');
      el('screen-admin').classList.remove('hidden');
      await loadConfig();
      await loadPhotos();
    } catch (err) {
      msg.innerHTML = `<div class="error-msg">${err.message}</div>`;
    }
  });

  el('pw').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el('loginBtn').click();
  });

  el('saveConfigBtn').addEventListener('click', async () => {
    const msg = el('configMsg');
    msg.innerHTML = '';
    const startVal = el('eventStart').value;
    const endVal = el('eventEnd').value;
    const votingHours = Number(el('votingHours').value || 24);
    if (!startVal || !endVal) {
      msg.innerHTML = '<div class="error-msg">Both start and end times are required.</div>';
      return;
    }
    try {
      await api('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventStart: new Date(startVal).toISOString(),
          eventEnd: new Date(endVal).toISOString(),
          votingHours,
        }),
      });
      msg.innerHTML = '<div class="success-msg">Timing saved.</div>';
      await loadConfig();
    } catch (err) {
      msg.innerHTML = `<div class="error-msg">${err.message}</div>`;
    }
  });

  el('saveUsersBtn').addEventListener('click', async () => {
    const msg = el('usersMsg');
    msg.innerHTML = '';
    const usernames = el('usernames').value.split('\n').map((s) => s.trim()).filter(Boolean);
    try {
      const data = await api('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames }),
      });
      msg.innerHTML = `<div class="success-msg">Saved ${data.users.length} guest name(s).</div>`;
    } catch (err) {
      msg.innerHTML = `<div class="error-msg">${err.message}</div>`;
    }
  });

  el('exportBtn').addEventListener('click', async () => {
    const msg = el('exportMsg');
    msg.innerHTML = '<p class="lede">Preparing backup…</p>';
    try {
      const res = await fetch('/api/admin/export', { headers: { 'x-admin-key': adminKey || '' } });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `photo-contest-backup-${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      msg.innerHTML = '<div class="success-msg">Backup downloaded.</div>';
    } catch (err) {
      msg.innerHTML = `<div class="error-msg">${err.message}</div>`;
    }
  });

  el('resetBtn').addEventListener('click', async () => {
    const msg = el('resetMsg');
    msg.innerHTML = '';
    if (!confirm('This deletes ALL photos and likes permanently. Continue?')) return;
    try {
      await api('/api/admin/reset', { method: 'POST' });
      msg.innerHTML = '<div class="success-msg">All photos and likes cleared.</div>';
      await loadPhotos();
    } catch (err) {
      msg.innerHTML = `<div class="error-msg">${err.message}</div>`;
    }
  });

  // Auto-unlock if we already have a session key.
  (async () => {
    if (adminKey) {
      try {
        await api('/api/admin/config');
        el('screen-lock').classList.add('hidden');
        el('screen-admin').classList.remove('hidden');
        await loadConfig();
        await loadPhotos();
      } catch {
        sessionStorage.removeItem(SESSION_KEY);
        adminKey = null;
      }
    }
  })();
})();
