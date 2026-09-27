(() => {
  const TOKEN_KEY = 'photocontest.hostToken';
  const EMAIL_KEY = 'photocontest.hostEmail';

  const el = (id) => document.getElementById(id);
  const screens = {
    auth: el('screen-auth'),
    events: el('screen-events'),
    create: el('screen-create'),
    detail: el('screen-detail'),
  };

  let token = localStorage.getItem(TOKEN_KEY) || null;
  let hostEmail = localStorage.getItem(EMAIL_KEY) || null;
  let authMode = 'login'; // or 'register'
  let currentEventId = null;
  let currentEvent = null;

  function showScreen(name) {
    Object.entries(screens).forEach(([key, node]) => {
      node.classList.toggle('hidden', key !== name);
    });
  }

  function renderWhoRow() {
    const row = el('hostWhoRow');
    if (token && hostEmail) {
      row.classList.remove('hidden');
      el('hostEmail').textContent = hostEmail;
    } else {
      row.classList.add('hidden');
    }
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      signOut();
      throw new Error(data.error || 'Please sign in again.');
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function signOut() {
    token = null;
    hostEmail = null;
    currentEventId = null;
    currentEvent = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EMAIL_KEY);
    renderWhoRow();
    showScreen('auth');
  }

  // ---------- Auth ----------

  function setAuthMode(mode) {
    authMode = mode;
    el('authMsg').innerHTML = '';
    if (mode === 'login') {
      el('authEyebrow').textContent = 'Sign in';
      el('authHeading').textContent = 'Welcome back';
      el('authSubmitBtn').textContent = 'Sign in';
      el('authToggleLede').textContent = 'New here?';
      el('authToggleBtn').textContent = 'Create an account';
      el('authPassword').setAttribute('autocomplete', 'current-password');
    } else {
      el('authEyebrow').textContent = 'Create account';
      el('authHeading').textContent = 'Set up your host account';
      el('authSubmitBtn').textContent = 'Create account';
      el('authToggleLede').textContent = 'Already have an account?';
      el('authToggleBtn').textContent = 'Sign in';
      el('authPassword').setAttribute('autocomplete', 'new-password');
    }
  }

  el('authToggleBtn').addEventListener('click', () => {
    setAuthMode(authMode === 'login' ? 'register' : 'login');
  });

  el('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = el('authEmail').value.trim();
    const password = el('authPassword').value;
    const msg = el('authMsg');
    msg.innerHTML = '';
    const submitBtn = el('authSubmitBtn');
    submitBtn.disabled = true;
    try {
      const endpoint = authMode === 'login' ? '/api/host/login' : '/api/host/register';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      token = data.token;
      hostEmail = data.email;
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(EMAIL_KEY, hostEmail);
      el('authForm').reset();
      renderWhoRow();
      await showEventsList();
    } catch (err) {
      msg.innerHTML = `<div class="error-msg">${err.message}</div>`;
    } finally {
      submitBtn.disabled = false;
    }
  });

  el('signOutBtn').addEventListener('click', async () => {
    try {
      await api('/api/host/logout', { method: 'POST' });
    } catch (_) {
      /* ignore -- signing out locally regardless */
    }
    signOut();
  });

  // ---------- Events list ----------

  function phaseLabel(phase) {
    const map = {
      not_configured: 'Not set up yet',
      before: 'Not started',
      upload: 'Uploads open',
      voting: 'Voting open',
      results: 'Results are in',
    };
    return map[phase] || phase;
  }

  async function showEventsList() {
    showScreen('events');
    const data = await api('/api/host/events');
    const list = el('eventsList');
    list.innerHTML = '';
    el('eventsEmpty').classList.toggle('hidden', data.events.length > 0);
    data.events.forEach((ev) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'card stack';
      card.style.cssText =
        'text-align:left; width:100%; cursor:pointer; border:1px solid var(--line); background:var(--surface); -webkit-appearance:none; appearance:none;';
      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:baseline; gap:10px;">
          <h3 style="font-size:16px; margin:0;">${ev.name}</h3>
          <span class="phase-chip" style="font-size:11px;">${phaseLabel(ev.phase)}</span>
        </div>
        <p class="lede" style="font-size:13px;">${ev.photoCount} photo${ev.photoCount === 1 ? '' : 's'} · ${ev.guestCount} guest${ev.guestCount === 1 ? '' : 's'}</p>`;
      card.addEventListener('click', () => openEvent(ev.id));
      list.appendChild(card);
    });
  }

  el('newEventBtn').addEventListener('click', () => {
    el('createMsg').innerHTML = '';
    el('createForm').reset();
    showScreen('create');
  });

  el('createCancelBtn').addEventListener('click', () => showEventsList());

  el('createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = el('createName').value.trim();
    const msg = el('createMsg');
    msg.innerHTML = '';
    try {
      const data = await api('/api/host/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      await openEvent(data.event.id);
    } catch (err) {
      msg.innerHTML = `<div class="error-msg">${err.message}</div>`;
    }
  });

  el('backToEventsBtn').addEventListener('click', () => showEventsList());

  // ---------- Event detail ----------

  function toLocalInputValue(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function openEvent(eventId) {
    currentEventId = eventId;
    const data = await api(`/api/host/events/${eventId}`);
    currentEvent = data.event;

    el('detailEventName').textContent = currentEvent.name;
    el('guestLinkField').value = currentEvent.guestUrl;
    el('detailPhaseInfo').textContent = `Current phase: ${phaseLabel(currentEvent.phase)}`;
    el('eventStart').value = toLocalInputValue(currentEvent.config.eventStart);
    el('eventEnd').value = toLocalInputValue(currentEvent.config.eventEnd);
    el('votingHours').value = currentEvent.config.votingHours || 24;
    el('usernames').value = data.users.join('\n');
    el('exportBtn').href = `/api/host/events/${eventId}/export`;

    ['configMsg', 'usersMsg', 'dangerMsg'].forEach((id) => (el(id).innerHTML = ''));
    showScreen('detail');
    await loadModeration();
  }

  el('copyLinkBtn').addEventListener('click', async () => {
    const field = el('guestLinkField');
    field.select();
    try {
      await navigator.clipboard.writeText(field.value);
      const btn = el('copyLinkBtn');
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => {
        btn.textContent = original;
      }, 1500);
    } catch (_) {
      /* clipboard API unavailable -- the field is at least selected for manual copy */
    }
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
      await api(`/api/host/events/${currentEventId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventStart: new Date(startVal).toISOString(),
          eventEnd: new Date(endVal).toISOString(),
          votingHours,
        }),
      });
      msg.innerHTML = '<div class="success-msg">Timing saved.</div>';
      await openEvent(currentEventId);
    } catch (err) {
      msg.innerHTML = `<div class="error-msg">${err.message}</div>`;
    }
  });

  el('saveUsersBtn').addEventListener('click', async () => {
    const msg = el('usersMsg');
    msg.innerHTML = '';
    const usernames = el('usernames').value.split('\n').map((s) => s.trim()).filter(Boolean);
    try {
      const data = await api(`/api/host/events/${currentEventId}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames }),
      });
      msg.innerHTML = `<div class="success-msg">Saved ${data.users.length} guest name(s).</div>`;
    } catch (err) {
      msg.innerHTML = `<div class="error-msg">${err.message}</div>`;
    }
  });

  async function loadModeration() {
    const apiPhotos = await fetch(`/api/e/${currentEvent.slug}/photos`).then((r) => r.json());
    const grid = el('modGrid');
    grid.innerHTML = '';
    el('modEmpty').classList.toggle('hidden', apiPhotos.photos.length > 0);
    apiPhotos.photos.forEach((p) => {
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
        await api(`/api/host/events/${currentEventId}/photos/${btn.dataset.id}`, { method: 'DELETE' });
        await loadModeration();
      });
    });
  }

  el('resetBtn').addEventListener('click', async () => {
    const msg = el('dangerMsg');
    msg.innerHTML = '';
    if (!confirm('This deletes ALL photos and likes for this event permanently. Continue?')) return;
    try {
      await api(`/api/host/events/${currentEventId}/reset`, { method: 'POST' });
      msg.innerHTML = '<div class="success-msg">Photos and likes cleared.</div>';
      await loadModeration();
    } catch (err) {
      msg.innerHTML = `<div class="error-msg">${err.message}</div>`;
    }
  });

  el('deleteEventBtn').addEventListener('click', async () => {
    const msg = el('dangerMsg');
    msg.innerHTML = '';
    if (!confirm(`Delete "${currentEvent.name}" entirely? This cannot be undone.`)) return;
    try {
      await api(`/api/host/events/${currentEventId}`, { method: 'DELETE' });
      await showEventsList();
    } catch (err) {
      msg.innerHTML = `<div class="error-msg">${err.message}</div>`;
    }
  });

  // ---------- Init ----------

  setAuthMode('login');
  renderWhoRow();
  if (token) {
    showEventsList().catch(() => signOut());
  } else {
    showScreen('auth');
  }
})();
