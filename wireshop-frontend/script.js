// script.js — full file (with PIN coercion)
document.addEventListener('DOMContentLoaded', () => {
  // ----- Config -----
  const API_URL = '/api/jobs'; // Render will proxy /api -> backend

  // ----- Common helpers -----
  const getUser = () => {
    try { return JSON.parse(localStorage.getItem('user')) || null; }
    catch { return null; }
  };

  const setUser = (u) => localStorage.setItem('user', JSON.stringify(u));
  const clearUser = () => localStorage.removeItem('user');

  async function api(path, options = {}) {
    const res = await fetch(`${API_URL}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    if (!res.ok) {
      const msg = await res.text().catch(()=>'');
      throw new Error(`HTTP ${res.status} ${res.statusText} - ${msg}`);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  // Duration formatter using start/end + pause fields
  function formatDuration(start, end, pauseStart, pauseTotal) {
    if (!start) return 'N/A';
    const now = Date.now();
    const effectiveEnd = end || now;

    // Total paused time = recorded pauses + current pause (if any)
    let totalPaused = pauseTotal || 0;
    if (pauseStart && !end) totalPaused += (now - pauseStart);

    let ms = Math.max(effectiveEnd - start - totalPaused, 0);
    const h = Math.floor(ms / 3600000); ms %= 3600000;
    const m = Math.floor(ms / 60000);   ms %= 60000;
    const s = Math.floor(ms / 1000);
    return `${h}h ${m}m ${s}s`;
  }

  // Find the open (endTime null) log id for a user+part
  async function getActiveLogId(username, partNumber) {
    const rows = await api(`/logs/${encodeURIComponent(username)}`, { method: 'GET' });
    const open = rows.find(r => r.partNumber === partNumber && !r.endTime);
    return open ? open.id : null;
  }

  // Populate a <select> with catalog parts (if present)
  function populateParts() {
    const sel = document.getElementById('partSelect');
    if (!sel || !Array.isArray(window.catalog)) return;
    sel.innerHTML = `<option value="">-- Select Part --</option>` +
      window.catalog.map(p =>
        `<option value="${p.partNumber}">${p.partNumber} — ${p.name || ''}</option>`
      ).join('');
  }

  // ====== PAGE: LOGIN (index.html) ======
  (function initLoginPage() {
    const form = document.getElementById('login-form');
    if (!form) return;

    const err = document.getElementById('error-message');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const username = (document.getElementById('usernameInput').value || '').trim().toLowerCase();
      const pin = (document.getElementById('pinInput').value || '').trim();

      // PIN fix: coerce both to strings
      const u = (window.users || []).find(x =>
        x &&
        typeof x.username === 'string' &&
        x.username.toLowerCase() === username &&
        String(x.pin) === String(pin)
      );

      if (!u) {
        if (err) err.textContent = 'Invalid username or PIN.';
        return;
      }
      err.textContent = '';
      setUser(u);
      window.location.href = 'dashboard.html';
    });
  })();

  // ====== PAGE: DASHBOARD (dashboard.html) ======
  (function initDashboardPage() {
    const welcome = document.getElementById('welcome-message');
    if (!welcome) return; // not on this page

    const user = getUser();
    if (!user) { window.location.href = 'index.html'; return; }

    // UI hooks
    const liveBtn = document.getElementById('liveViewBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const partSelect = document.getElementById('partSelect');
    const actionSelect = document.getElementById('actionSelect');
    const notesInput = document.getElementById('notesInput');
    const submitLogBtn = document.getElementById('submitLog');
    const logTableBody = document.getElementById('logTableBody');
    const deleteAllBtn = document.getElementById('deleteAllLogs');

    // Greet
    welcome.textContent = `Welcome, ${user.username}${user.role ? ' (' + user.role + ')' : ''}`;

    // Nav
    if (liveBtn) liveBtn.addEventListener('click', () => window.location.href = 'admin.html');
    if (logoutBtn) logoutBtn.addEventListener('click', () => { clearUser(); window.location.href = 'index.html'; });

    // Populate parts and actions
    populateParts();
    if (actionSelect) {
      actionSelect.innerHTML = `
        <option value="">-- Select Action --</option>
        <option value="Start">Start</option>
        <option value="Pause">Pause</option>
        <option value="Continue">Continue</option>
        <option value="Finish">Finish</option>
      `;
    }

    // Render this user’s logs table
    async function refreshMyLogs() {
      const rows = await api(`/logs/${encodeURIComponent(user.username)}`, { method: 'GET' });
      if (!logTableBody) return;
      logTableBody.innerHTML = '';
      rows.forEach(log => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${log.partNumber || ''}</td>
          <td>${log.action || ''}</td>
          <td>${log.startTime ? new Date(log.startTime).toLocaleString() : ''}</td>
          <td>${log.note || ''}</td>
          <td>${formatDuration(log.startTime, log.endTime, log.pauseStart, log.pauseTotal)}</td>
        `;
        logTableBody.appendChild(tr);
      });
    }

    // Submit action
    if (submitLogBtn) {
      submitLogBtn.addEventListener('click', async () => {
        const partNumber = partSelect ? partSelect.value : '';
        const action = actionSelect ? actionSelect.value : '';
        const note = notesInput ? notesInput.value.trim() : '';

        if (!partNumber || !action) {
          alert('Please select a part and an action.');
          return;
        }

        try {
          if (action === 'Start') {
            // Create new log
            await api(`/log`, {
              method: 'POST',
              body: JSON.stringify({
                username: user.username,
                partNumber,
                action: 'Start',
                note,
                startTime: Date.now()
              })
            });
          } else {
            // Update existing open log for this part
            const id = await getActiveLogId(user.username, partNumber);
            if (!id) { alert('No active log for this part. Start one first.'); return; }

            const body = { action };
            if (action === 'Finish') body.endTime = Date.now();

            await api(`/log/${id}`, {
              method: 'PUT',
              body: JSON.stringify(body)
            });
          }

          // Clear note field and refresh
          if (notesInput) notesInput.value = '';
          await refreshMyLogs();
        } catch (err) {
          console.error(err);
          alert('Failed to submit action. Check console for details.');
        }
      });
    }

    // Delete all my logs
    if (deleteAllBtn) {
      deleteAllBtn.addEventListener('click', async () => {
        if (!confirm('Delete ALL your logs? This cannot be undone.')) return;
        try {
          await api(`/delete-logs/${encodeURIComponent(user.username)}`, { method: 'DELETE' });
          await refreshMyLogs();
        } catch (err) {
          console.error(err);
          alert('Failed to delete logs.');
        }
      });
    }

    // Initial render + periodic refresh
    refreshMyLogs().catch(console.error);
    const interval = setInterval(refreshMyLogs, 5000);
    window.addEventListener('beforeunload', () => clearInterval(interval));
  })();

  // ====== PAGE: ADMIN (admin.html) ======
  (function initAdminPage() {
    const backBtn = document.getElementById('backToDashboard');
    const tableBody = document.getElementById('activityTableBody');
    if (!backBtn && !tableBody) return; // not on admin page

    const user = getUser();
    if (!user) { window.location.href = 'index.html'; return; }

    if (backBtn) backBtn.addEventListener('click', () => window.location.href = 'dashboard.html');

    const clearAllBtn = document.getElementById('clearAllLogs');
    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', async () => {
        if (!confirm('Clear ALL logs for ALL users?')) return;
        try {
          await api(`/admin/clear-logs`, { method: 'DELETE' });
          await fetchAll();
        } catch (err) {
          console.error(err);
          alert('Failed to clear logs.');
        }
      });
    }

    async function fetchAll() {
      try {
        const rows = await api(`/logs`, { method: 'GET' });
        if (!tableBody) return;

        tableBody.innerHTML = '';
        rows.forEach(log => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>${log.username || ''}</td>
            <td>${log.partNumber || ''}</td>
            <td>${log.action || ''}</td>
            <td>${log.note || ''}</td>
            <td>${formatDuration(log.startTime, log.endTime, log.pauseStart, log.pauseTotal)}</td>
          `;
          tableBody.appendChild(tr);
        });
      } catch (err) {
        console.error(err);
      }
    }

    // Initial + live refresh
    fetchAll().catch(console.error);
    const interval = setInterval(fetchAll, 5000);
    window.addEventListener('beforeunload', () => clearInterval(interval));
  })();
});
