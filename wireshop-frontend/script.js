// script.js — uses window.catalog.{printName,expectedHours} + your backend URL

document.addEventListener('DOMContentLoaded', () => {
  // ---- Backend URL (the one that worked this morning) ----
  const API_URL = 'https://czm-wireshop.onrender.com/api/jobs';

  // ---------- tiny helpers ----------
  const safeJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const user = safeJSON(localStorage.getItem('user'));
  const qs = (sel) => document.querySelector(sel);
  const html = (s) => String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

  // ---------- LOGIN ----------
  if (qs('#login-form')) {
    const err = qs('#error-message');
    qs('#login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const u = (window.users || []).find(x =>
        x.username.toLowerCase() === qs('#usernameInput').value.trim().toLowerCase() &&
        String(x.pin) === String(qs('#pinInput').value).trim()
      );
      if (!u) { if (err) err.textContent = 'Invalid username or PIN.'; return; }
      localStorage.setItem('user', JSON.stringify(u));
      window.location.href = 'dashboard.html';
    });
    return; // stop here on login page
  }

  // ---------- ROUTE GUARD ----------
  const onDash  = location.pathname.includes('dashboard.html');
  const onAdmin = location.pathname.includes('admin.html');
  if ((onDash || onAdmin) && !user) { location.href = 'index.html'; return; }

  // ---------- DASHBOARD ----------
  if (onDash) {
    // header buttons
    const liveBtn = qs('#liveViewBtn');
    const logoutBtn = qs('#logoutBtn');
    if (logoutBtn) logoutBtn.onclick = () => { localStorage.removeItem('user'); location.href = 'index.html'; };
    if (liveBtn) liveBtn.onclick = () => location.href = 'admin.html';

    // welcome
    const name = user?.username ? user.username[0].toUpperCase() + user.username.slice(1) : '';
    const role = user?.role ? ` (${user.role})` : '';
    const welcome = qs('#welcome-message'); if (welcome) welcome.textContent = `Welcome, ${name}${role}`;

    // elements
    const partSelect   = qs('#partSelect');
    const actionSelect = qs('#actionSelect');
    const notesInput   = qs('#notes');
    const logTableBody = qs('#logTableBody');

    const spanTime = qs('#expectedTime');
    const spanNotes = qs('#expectedNotes');
    const spanLoc = qs('#expectedLocation');
    const spanSA = qs('#expectedSA');

    // build dropdown from window.catalog (printName/expectedHours)
    function populateParts() {
      const list = Array.isArray(window.catalog) ? window.catalog : [];
      const items = list.filter(r => r && r.partNumber).sort((a,b)=>String(a.partNumber).localeCompare(String(b.partNumber)));
      partSelect.innerHTML = `<option value="">-- Select Part --</option>` +
        items.map(p => `<option value="${html(p.partNumber)}">${html(p.partNumber)} — ${html(p.printName || '')}</option>`).join('');
    }
    populateParts();

    // reflect current selection info
    function updatePartInfo() {
      const pn = partSelect.value;
      const rec = (window.catalog || []).find(r => r.partNumber === pn);
      spanTime.textContent  = (rec && Number.isFinite(rec.expectedHours)) ? rec.expectedHours : '--';
      spanNotes.textContent = (rec && rec.notes && String(rec.notes).trim()) ? rec.notes : '--';
      spanLoc.textContent   = (rec && rec.location && String(rec.location).trim()) ? rec.location : '--';
      spanSA.textContent    = (rec && rec.saNumber && String(rec.saNumber).trim()) ? rec.saNumber : '--';
    }
    partSelect.addEventListener('change', updatePartInfo);
    updatePartInfo();

    // actions
    actionSelect.innerHTML = `
      <option value="">-- Select Action --</option>
      <option value="Start">Start</option>
      <option value="Pause">Pause</option>
      <option value="Continue">Continue</option>
      <option value="Finish">Finish</option>
    `;

    // active logs tracking
    let active = new Set();

    // utilities
    const fmtDur = (start, end, pauseStart, pauseTotal) => {
      if (!start) return 'N/A';
      const now = Date.now();
      const stop = end || now;
      let paused = pauseTotal || 0;
      if (pauseStart && !end) paused += (now - pauseStart);
      let ms = Math.max(stop - start - paused, 0);
      const h = Math.floor(ms/3600000); ms %= 3600000;
      const m = Math.floor(ms/60000);   ms %= 60000;
      const s = Math.floor(ms/1000);
      return `${h}h ${m}m ${s}s`;
    };

    async function fetchMyLogs() {
      try {
        const res = await fetch(`${API_URL}/logs/${encodeURIComponent(user.username)}`);
        if (!res.ok) throw new Error(`GET /logs/${user.username} -> ${res.status}`);
        const rows = await res.json();
        // render
        logTableBody.innerHTML = '';
        rows.forEach(log => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>${html(log.partNumber || '')}</td>
            <td>${html(log.action || '')}</td>
            <td>${log.timestamp ? new Date(log.timestamp).toLocaleString() : ''}</td>
            <td>${html(log.note || '')}</td>
            <td>${fmtDur(log.startTime, log.endTime, log.pauseStart, log.pauseTotal)}</td>
          `;
          logTableBody.appendChild(tr);
        });
        // rebuild active set
        active = new Set(rows.filter(r => !r.endTime).map(r => r.partNumber));
      } catch (e) {
        console.error(e);
      }
    }

    qs('#submitLog').addEventListener('click', async () => {
      const partNumber = partSelect.value;
      const action = actionSelect.value;
      const note = (notesInput.value || '').trim();
      if (!partNumber || !action) return alert('Please select a part and action.');

      const isStart = action === 'Start';
      const isActive = active.has(partNumber);
      if (isStart && isActive) return alert('You already have an active log for this part.');
      if (!isStart && !isActive) return alert('No active log for this part. Start one first.');

      try {
        const res = await fetch(`${API_URL}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: user.username, partNumber, action, note })
        });
        if (!res.ok) throw new Error(`POST /api/jobs -> ${res.status}`);
        notesInput.value = ''; actionSelect.value = '';
        await fetchMyLogs();
      } catch (e) {
        console.error(e);
        alert('Failed to submit log.');
      }
    });

    qs('#deleteAllLogs').addEventListener('click', async () => {
      if (!confirm('Delete ALL of your logs?')) return;
      try {
        const res = await fetch(`${API_URL}/logs/${encodeURIComponent(user.username)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`DELETE /logs/${user.username} -> ${res.status}`);
        await fetchMyLogs();
      } catch (e) {
        console.error(e); alert('Delete failed.');
      }
    });

    // poll
    setInterval(fetchMyLogs, 5000);
    fetchMyLogs();
  }

  // ---------- ADMIN ----------
  if (onAdmin) {
    if (user?.role !== 'admin') { location.href = 'dashboard.html'; return; }
    const tbody = qs('#activityTableBody');

    async function pullAll() {
      try {
        const res = await fetch(`${API_URL}/admin/logs`);
        if (!res.ok) throw new Error(`GET /admin/logs -> ${res.status}`);
        const rows = await res.json();
        tbody.innerHTML = '';
        rows.forEach(log => {
          const tr = document.createElement('tr');
          const ms = (a,b,pStart,pTot) => {
            if (!a) return 'N/A';
            const now = Date.now(); const end = b || now;
            let paused = pTot || 0; if (pStart && !b) paused += (now - pStart);
            const d = Math.max(end - a - paused, 0);
            const h=Math.floor(d/3600000), m=Math.floor(d%3600000/60000), s=Math.floor(d%60000/1000);
            return `${h}h ${m}m ${s}s`;
          };
          tr.innerHTML = `
            <td>${html(log.username || '')}</td>
            <td>${html(log.partNumber || '')}</td>
            <td>${html(log.action || '')}</td>
            <td>${html(log.note || '')}</td>
            <td>${ms(log.startTime, log.endTime, log.pauseStart, log.pauseTotal)}</td>
          `;
          tbody.appendChild(tr);
        });
      } catch (e) { console.error(e); }
    }

    const clearBtn = qs('#clearAllLogs');
    if (clearBtn) clearBtn.onclick = async () => {
      if (!confirm('Clear ALL logs for ALL users?')) return;
      try {
        const res = await fetch(`${API_URL}/admin/clear-logs`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`DELETE /admin/clear-logs -> ${res.status}`);
        await pullAll(); alert('All logs cleared.');
      } catch (e) { console.error(e); alert('Error clearing logs.'); }
    };

    qs('#backToDashboard').onclick = () => location.href = 'dashboard.html';
    setInterval(pullAll, 5000);
    pullAll();
  }
});
