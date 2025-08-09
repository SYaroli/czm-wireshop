// script.js — role-aware + x-user header
document.addEventListener('DOMContentLoaded', () => {
  // Using direct backend URL; we can switch back to /api later if you want
  const API_URL = 'https://wireshop-backend.onrender.com/api/jobs';

  // ---------- Helpers ----------
  const getUser = () => { try { return JSON.parse(localStorage.getItem('user')) || null; } catch { return null; } };
  const setUser = (u) => localStorage.setItem('user', JSON.stringify(u));
  const clearUser = () => localStorage.removeItem('user');
  const currentUsername = () => (getUser()?.username || '');

  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', 'x-user': currentUsername() };
    const res = await fetch(`${API_URL}${path}`, { headers, ...options });
    if (!res.ok) { const msg = await res.text().catch(()=> ''); throw new Error(`HTTP ${res.status} ${res.statusText} - ${msg}`); }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  function formatDuration(start, end, pauseStart, pauseTotal) {
    if (!start) return 'N/A';
    const now = Date.now();
    const effectiveEnd = end || now;
    let totalPaused = pauseTotal || 0;
    if (pauseStart && !end) totalPaused += (now - pauseStart);
    let ms = Math.max(effectiveEnd - start - totalPaused, 0);
    const h = Math.floor(ms / 3600000); ms %= 3600000;
    const m = Math.floor(ms / 60000);   ms %= 60000;
    const s = Math.floor(ms / 1000);
    return `${h}h ${m}m ${s}s`;
  }

  // ---------- LOGIN ----------
  (function initLoginPage() {
    const form = document.getElementById('login-form');
    if (!form) return;
    const err = document.getElementById('error-message');

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const username = (document.getElementById('usernameInput').value || '').trim().toLowerCase();
      const pin = (document.getElementById('pinInput').value || '').trim();

      const u = (window.users || []).find(x =>
        x && typeof x.username === 'string' &&
        x.username.toLowerCase() === username &&
        String(x.pin) === String(pin)
      );

      if (!u) { if (err) err.textContent = 'Invalid username or PIN.'; return; }
      err.textContent = '';
      setUser(u);
      window.location.href = 'dashboard.html';
    });
  })();

  // ---------- DASHBOARD ----------
  (function initDashboardPage() {
    const welcome = document.getElementById('welcome-message');
    if (!welcome) return;

    const user = getUser();
    if (!user) { window.location.href = 'index.html'; return; }

    const liveBtn = document.getElementById('liveViewBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const partSelect = document.getElementById('partSelect');
    const actionSelect = document.getElementById('actionSelect');
    const notesInput = document.getElementById('notes');
    const submitLogBtn = document.getElementById('submitLog');
    const logTableBody = document.getElementById('logTableBody');
    const deleteAllBtn = document.getElementById('deleteAllLogs');

    const spanTime = document.getElementById('expectedTime');
    const spanNotes = document.getElementById('expectedNotes');
    const spanLoc  = document.getElementById('expectedLocation');
    const spanSA   = document.getElementById('expectedSA');

    welcome.textContent = `Welcome, ${user.username}${user.role ? ' (' + user.role + ')' : ''}`;

    // Hide admin UI for non-admins
    const isAdmin = String(user.role || '').toLowerCase() === 'admin';
    if (!isAdmin) {
      if (liveBtn) liveBtn.style.display = 'none';
      if (deleteAllBtn) deleteAllBtn.style.display = 'none';
    }

    if (liveBtn) liveBtn.addEventListener('click', () => window.location.href = 'admin.html');
    if (logoutBtn) logoutBtn.addEventListener('click', () => { clearUser(); window.location.href = 'index.html'; });

    // Parts dropdown: partNumber — printName (sorted by partNumber)
    function populateParts() {
      if (!partSelect || !Array.isArray(window.catalog)) return;
      const items = [...window.catalog]
        .filter(r => r.partNumber)
        .sort((a, b) => String(a.partNumber).localeCompare(String(b.partNumber)));
      partSelect.innerHTML =
        `<option value="">-- Select Part --</option>` +
        items.map(p => `<option value="${p.partNumber}">${p.partNumber} — ${p.printName || ''}</option>`).join('');
    }
    populateParts();

    partSelect.addEventListener('change', () => {
      const pn = partSelect.value;
      const rec = (window.catalog || []).find(r => r.partNumber === pn);
      spanTime.textContent = rec && rec.expectedHours != null ? rec.expectedHours : '--';
      spanNotes.textContent = rec && rec.notes ? rec.notes : '--';
      spanLoc.textContent = rec && rec.location ? rec.location : '--';
      spanSA.textContent = rec && rec.saNumber ? rec.saNumber : '--';
    });

    if (actionSelect) {
      actionSelect.innerHTML = `
        <option value="">-- Select Action --</option>
        <option value="Start">Start</option>
        <option value="Pause">Pause</option>
        <option value="Continue">Continue</option>
        <option value="Finish">Finish</option>
      `;
    }

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

    if (submitLogBtn) {
      submitLogBtn.addEventListener('click', async () => {
        const partNumber = partSelect ? partSelect.value : '';
        const action = actionSelect ? actionSelect.value : '';
        const note = notesInput ? notesInput.value.trim() : '';
        if (!partNumber || !action) { alert('Please select a part and an action.'); return; }

        try {
          if (action === 'Start') {
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
            // find open log for this part
            const rows = await api(`/logs/${encodeURIComponent(user.username)}`, { method: 'GET' });
            const open = rows.find(r => r.partNumber === partNumber && !r.endTime);
            if (!open) { alert('No active log for this part. Start one first.'); return; }
            const body = { action };
            if (action === 'Finish') body.endTime = Date.now();
            await api(`/log/${open.id}`, { method: 'PUT', body: JSON.stringify(body) });
          }

          if (notesInput) notesInput.value = '';
          await refreshMyLogs();
        } catch (err) {
          console.error(err);
          alert('Failed to submit action. Check console for details.');
        }
      });
    }

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

    refreshMyLogs().catch(console.error);
    const interval = setInterval(refreshMyLogs, 5000);
    window.addEventListener('beforeunload', () => clearInterval(interval));
  })();

  // ---------- ADMIN ----------
  (function initAdminPage() {
    const backBtn = document.getElementById('backToDashboard');
    const tableBody = document.getElementById('activityTableBody');
    if (!backBtn && !tableBody) return;

    const user = getUser();
    if (!user) { window.location.href = 'index.html'; return; }
    const isAdmin = String(user.role || '').toLowerCase() === 'admin';
    if (!isAdmin) { window.location.href = 'dashboard.html'; return; }

    if (backBtn) backBtn.addEventListener('click', () => window.location.href = 'dashboard.html');

    const clearAllBtn = document.getElementById('clearAllLogs');
    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', async () => {
        if (!confirm('Clear ALL logs for ALL users?')) return;
        try { await api(`/admin/clear-logs`, { method: 'DELETE' }); await fetchAll(); }
        catch (err) { console.error(err); alert('Failed to clear logs.'); }
      });
    }

    async function fetchAll() {
      try {
        const rows = await api(`/logs`, { method: 'GET' }); // admin-only, enforced server-side
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
        alert('Failed to load admin logs.');
      }
    }

    fetchAll().catch(console.error);
    const interval = setInterval(fetchAll, 5000);
    window.addEventListener('beforeunload', () => clearInterval(interval));
  })();
});
