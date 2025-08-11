// script.js — full file

document.addEventListener('DOMContentLoaded', () => {
  // ===== Config =====
  const API_BASE = 'https://czm-wireshop.onrender.com'; // change if your backend URL differs
  const API_URL  = `${API_BASE}/api/jobs`;

  // ===== Session =====
  const user = safeParse(localStorage.getItem('user')); // { username, role }

  // ===== Page flags =====
  const path = window.location.pathname || '';
  const onLogin  = path.includes('index.html') || !/\.html$/.test(path); // default page
  const onDash   = path.includes('dashboard.html');
  const onAdmin  = path.includes('admin.html');

  // ===== Login handling =====
  const loginForm = document.getElementById('login-form');
  const errorMessage = document.getElementById('error-message');
  if (loginForm) {
    loginForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const username = val('#usernameInput').trim().toLowerCase();
      const pin = val('#pinInput').trim();
      const foundUser = (window.users || []).find(
        u => u.username.toLowerCase() === username && u.pin === pin
      );
      if (foundUser) {
        localStorage.setItem('user', JSON.stringify(foundUser));
        window.location.href = foundUser.role === 'admin' ? 'admin.html' : 'dashboard.html';
      } else {
        if (errorMessage) errorMessage.textContent = 'Invalid username or PIN';
      }
    });
  }

  // ===== Route guard =====
  if (!onLogin && !user) {
    window.location.href = 'index.html';
    return;
  }
  if (onAdmin && user && user.role !== 'admin') {
    window.location.href = 'dashboard.html';
    return;
  }

  // ===== Header buttons (present on dash/admin) =====
  wire('#logoutBtn', 'click', () => {
    localStorage.removeItem('user');
    window.location.href = 'index.html';
  });

  wire('#liveViewBtn', 'click', () => {
    if (user && user.role === 'admin') {
      window.location.href = 'admin.html';
    } else {
      alert('Admin only.');
    }
  });

  let updateTimer;

  // ===================== Dashboard =====================
  if (onDash) {
    text('#welcome-message', `Welcome, ${capitalize(user.username)}`);

    const partSelect     = qs('#partSelect');
    const expectedTimeEl = qs('#expectedTime');
    const partNotesEl    = qs('#partNotes');
    const actionSelect   = qs('#actionSelect');
    const notesInput     = qs('#notes');
    const logTableBody   = qs('#logTableBody');

    // Build dropdown from catalog, guarding against bad rows
    const catalog = Array.isArray(window.catalog) ? window.catalog : [];
    if (partSelect) {
      partSelect.innerHTML = '<option value="">-- Select Part --</option>';
      catalog.forEach(item => {
        if (!item || !item.partNumber) return;
        const safeName = (item.name && String(item.name).trim()) ? item.name : '—';
        const opt = document.createElement('option');
        opt.value = String(item.partNumber);
        opt.textContent = `${item.partNumber} - ${safeName}`;
        partSelect.appendChild(opt);
      });
    }

    // Update info box when part changes
    function updatePartInfo() {
      const pn = partSelect ? partSelect.value : '';
      const sel = catalog.find(i => i && i.partNumber === pn);

      const hours = sel && sel.hours != null && String(sel.hours).trim() !== '' ? sel.hours : '--';
      const notes = sel && sel.notes && String(sel.notes).trim() !== '' ? sel.notes : '--';

      if (expectedTimeEl) expectedTimeEl.textContent = `Expected Time: ${hours} hours`;
      if (partNotesEl)    partNotesEl.textContent    = `Notes: ${notes}`;
    }
    wire('#partSelect', 'change', updatePartInfo);
    updatePartInfo(); // initialize

    // Active log tracking to prevent duplicates
    let activeLogs = new Set();

    async function fetchLogs() {
      try {
        const res = await fetch(`${API_URL}/logs/${encodeURIComponent(user.username)}`);
        if (!res.ok) throw new Error(`GET logs ${res.status}`);
        const data = await res.json();
        renderLogs(data);
        // rebuild active set
        activeLogs = new Set(data.filter(l => !l.endTime).map(l => l.partNumber));
      } catch (e) {
        console.error('Failed to fetch logs:', e);
      }
    }

    function renderLogs(logs) {
      if (!logTableBody) return;
      logTableBody.innerHTML = '';
      logs.forEach(log => {
        const tr = document.createElement('tr');
        const duration = log.startTime
          ? calculateDuration(log.startTime, log.endTime, log.pauseStart, log.pauseTotal)
          : 'N/A';
        tr.innerHTML = `
          <td>${escapeHTML(log.partNumber || '')}</td>
          <td>${escapeHTML(log.action || '')}</td>
          <td>${new Date(log.timestamp).toLocaleString()}</td>
          <td>${escapeHTML(log.note || '')}</td>
          <td>${duration}</td>
        `;
        logTableBody.appendChild(tr);
      });
    }

    wire('#submitLog', 'click', async () => {
      const partNumber = partSelect ? partSelect.value : '';
      const action = actionSelect ? actionSelect.value : '';
      const note = (notesInput ? notesInput.value : '').trim();

      if (!partNumber || !action) {
        alert('Please select a part and action.');
        return;
      }

      const isStart  = action === 'Start';
      const isActive = activeLogs.has(partNumber);

      if (isStart && isActive) {
        alert('You already have an active log for this part.');
        return;
      } else if (!isStart && !isActive) {
        alert('No active log for this part. Start a new one first.');
        return;
      }

      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: user.username, partNumber, action, note }),
        });
        if (!res.ok) throw new Error(`POST ${res.status}`);
        // reset UI
        if (notesInput) notesInput.value = '';
        if (actionSelect) actionSelect.value = '';
        await fetchLogs();
      } catch (e) {
        console.error('Error submitting log:', e);
        alert('Failed to submit log.');
      }
    });

    wire('#deleteAllLogs', 'click', async () => {
      if (!confirm('Delete your entire log history?')) return;
      try {
        const res = await fetch(`${API_URL}/logs/${encodeURIComponent(user.username)}`, {
          method: 'DELETE'
        });
        if (!res.ok) throw new Error(`DELETE ${res.status}`);
        await fetchLogs();
      } catch (e) {
        console.error('Failed to delete logs:', e);
        alert('Delete failed.');
      }
    });

    // Start polling
    updateTimer = setInterval(fetchLogs, 5000);
    fetchLogs();
  }

  // ===================== Admin =====================
  if (onAdmin) {
    const tbody = qs('#activityTableBody');

    async function fetchAllLogs() {
      try {
        const res = await fetch(`${API_URL}/admin/logs`);
        if (!res.ok) throw new Error(`GET admin/logs ${res.status}`);
        const logs = await res.json();
        if (!tbody) return;
        tbody.innerHTML = '';
        logs.forEach(log => {
          const tr = document.createElement('tr');
          const duration = log.startTime && log.endTime
            ? calculateDuration(log.startTime, log.endTime, log.pauseStart, log.pauseTotal)
            : 'N/A';
          tr.innerHTML = `
            <td>${escapeHTML(log.username || '')}</td>
            <td>${escapeHTML(log.partNumber || '')}</td>
            <td>${escapeHTML(log.action || '')}</td>
            <td>${escapeHTML(log.note || '')}</td>
            <td>${duration}</td>
          `;
          tbody.appendChild(tr);
        });
      } catch (e) {
        console.error('Failed to load admin logs:', e);
      }
    }

    wire('#clearAllLogs', 'click', async () => {
      if (!confirm('Clear ALL logs for ALL users? This cannot be undone.')) return;
      try {
        const res = await fetch(`${API_URL}/admin/clear-logs`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`DELETE admin/clear-logs ${res.status}`);
        await fetchAllLogs();
        alert('All logs cleared.');
      } catch (e) {
        console.error('Error clearing logs:', e);
        alert('Error clearing logs.');
      }
    });

    wire('#backToDashboard', 'click', () => window.location.href = 'dashboard.html');

    updateTimer = setInterval(fetchAllLogs, 5000);
    fetchAllLogs();
  }

  // ===== Cleanup =====
  window.addEventListener('beforeunload', () => updateTimer && clearInterval(updateTimer));

  // ===== Helpers =====
  function calculateDuration(start, end, pauseStart, pauseTotal) {
    if (!start) return 'N/A';
    const now = Date.now();
    const endTime = end || now;
    let duration = endTime - start - (pauseTotal || 0);
    if (pauseStart && !end) duration -= (now - pauseStart);
    if (duration < 0) duration = 0;
    const h = Math.floor(duration / 3600000);
    const m = Math.floor((duration % 3600000) / 60000);
    const s = Math.floor((duration % 60000) / 1000);
    return `${h}h ${m}m ${s}s`;
  }

  function safeParse(s) {
    try { return JSON.parse(s || 'null'); } catch { return null; }
  }
  function qs(sel) { return document.querySelector(sel); }
  function val(sel) { const el = qs(sel); return el ? el.value : ''; }
  function text(sel, t) { const el = qs(sel); if (el) el.textContent = t; }
  function wire(sel, evt, fn) { const el = qs(sel); if (el) el.addEventListener(evt, fn); }
  function capitalize(s){ return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
  function escapeHTML(str){
    return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }
});
