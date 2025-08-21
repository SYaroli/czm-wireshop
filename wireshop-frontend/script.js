// script.js — login + dashboard + assignment sync
document.addEventListener('DOMContentLoaded', () => {
  const API_ROOT = 'https://wireshop-backend.onrender.com';
  const API_JOBS = `${API_ROOT}/api/jobs`;
  const API_ASSIGN = `${API_ROOT}/api/assignments`;
  const API_USERS = `${API_ROOT}/api/users`;

  // --------- Shared helpers ---------
  const getUser = () => { try { return JSON.parse(localStorage.getItem('user')) || null; } catch { return null; } };
  const setUser = (u) => localStorage.setItem('user', JSON.stringify(u));
  const clearUser = () => localStorage.removeItem('user');
  const username = () => (getUser()?.username || '');

  async function apiFetch(url, options = {}) {
    const headers = { 'Content-Type': 'application/json', 'x-user': username() };
    const res = await fetch(url, { headers, ...options });
    if (!res.ok) {
      let msg = '';
      try { msg = await res.text(); } catch {}
      throw new Error(`HTTP ${res.status} ${res.statusText} ${msg ? `- ${msg}` : ''}`);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }
  const jobsApi   = (path, options={}) => apiFetch(`${API_JOBS}${path}`, options);
  const assignApi = (path, options={}) => apiFetch(`${API_ASSIGN}${path}`, options);

  function fmtHMM(mins){
    if (mins == null || isNaN(mins)) return '';
    const h = Math.floor(mins/60), m = Math.abs(mins%60);
    return `${h}:${String(m).padStart(2,'0')}`;
  }
  function fmtDuration(start, end, pauseStart, pauseTotal) {
    if (!start) return '';
    const now = Date.now();
    const effectiveEnd = end || now;
    let paused = pauseTotal || 0;
    if (pauseStart && !end) paused += (now - pauseStart);
    let ms = Math.max(effectiveEnd - start - paused, 0);
    const h = Math.floor(ms/3600000); ms%=3600000;
    const m = Math.floor(ms/60000);   ms%=60000;
    const s = Math.floor(ms/1000);
    return `${h}h ${m}m ${s}s`;
  }

  // ===== LOGIN PAGE (index.html) =====
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    const $u = document.getElementById('usernameInput');
    const $p = document.getElementById('pinInput');
    const $err = document.getElementById('error-message');

    loginForm.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const uname = ($u.value||'').trim();
      const pin   = ($p.value||'').trim();
      $err.textContent = '';
      try{
        const data = await apiFetch(`${API_USERS}/login`, {
          method:'POST',
          body: JSON.stringify({ username: uname, pin })
        });
        setUser({ username: data.username, role: data.role });
        window.location.href = 'dashboard.html';
      }catch(err){
        $err.textContent = 'Invalid username or PIN.';
      }
    });
    return; // Stop here on login page
  }

  // ===== DASHBOARD (dashboard.html) =====
  // Guard: must be logged in
  if (!getUser()) { window.location.href = 'index.html'; return; }

  // Header bits, if present
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', ()=>{ clearUser(); window.location.href='index.html'; });

  // Part picker + info cards
  const partSelect       = document.getElementById('partSelect');
  const expectedTimeEl   = document.getElementById('expectedTime');
  const expectedSAEl     = document.getElementById('expectedSA');
  const expectedLocEl    = document.getElementById('expectedLocation');
  const expectedNotesEl  = document.getElementById('expectedNotes');

  function getCatalog(){ return Array.isArray(window.catalog) ? window.catalog : []; }
  function partByPN(pn){ return getCatalog().find(p => String(p.partNumber) === String(pn)); }

  function fillInfoFromPart(pn){
    const p = partByPN(pn) || {};
    if (expectedTimeEl) expectedTimeEl.textContent = typeof p.expectedHours === 'number' ? `${p.expectedHours}` : '';
    if (expectedSAEl)   expectedSAEl.textContent   = p.saNumber ?? '';
    if (expectedLocEl)  expectedLocEl.textContent  = p.location ?? '';
    if (expectedNotesEl)expectedNotesEl.textContent= p.notes ?? '';
  }

  if (partSelect) {
    // Build the dropdown
    const items = getCatalog()
      .filter(p => p && p.partNumber)
      .map(p => ({
        pn: String(p.partNumber),
        label: `${p.partNumber} — ${p.printName || ''}`,
        hours: typeof p.expectedHours === 'number' ? p.expectedHours : '',
        print: p.printName || '',
        notes: p.notes || ''
      }))
      .sort((a,b)=> a.pn.localeCompare(b.pn));

    partSelect.innerHTML = '<option value="">-- Select part --</option>';
    for (const it of items) {
      const o = document.createElement('option');
      o.value = it.pn;
      o.textContent = it.label;
      o.dataset.hours = it.hours;
      o.dataset.print = it.print;
      o.dataset.notes = it.notes;
      partSelect.appendChild(o);
    }
    partSelect.addEventListener('change', ()=> fillInfoFromPart(partSelect.value));
  }

  // ===== Assignments sync helpers =====
  // Find the earliest assignment for this user/part with a given status
  async function findAssignment(user, partNumber, status) {
    const qs = `?username=${encodeURIComponent(user)}&status=${encodeURIComponent(status)}`;
    try{
      const rows = await assignApi(qs, { method:'GET' });
      if (!Array.isArray(rows)) return null;
      const matches = rows.filter(r => String(r.partNumber||'') === String(partNumber||''));
      if (!matches.length) return null;
      matches.sort((a,b)=> (a.createdAt||0) - (b.createdAt||0)); // earliest first
      return matches[0];
    }catch { return null; }
  }
  async function maybeMarkAssignmentInProgress(user, partNumber) {
    try {
      const row = await findAssignment(user, partNumber, 'Open');
      if (row) await assignApi(`/${row.id}`, { method:'PATCH', body: JSON.stringify({ status:'InProgress' }) });
    } catch {}
  }
  async function maybeMarkAssignmentCompleted(user, partNumber) {
    try {
      let row = await findAssignment(user, partNumber, 'InProgress');
      if (!row) row = await findAssignment(user, partNumber, 'Open'); // safety net
      if (row) await assignApi(`/${row.id}`, { method:'PATCH', body: JSON.stringify({ status:'Completed' }) });
    } catch {}
  }

  // ===== Live logs (mine) =====
  const logTbody = document.getElementById('logTableBody');
  const submitLogBtn = document.getElementById('submitLog');
  const deleteAllBtn = document.getElementById('deleteAllLogs');
  const myCompletedBody = document.getElementById('myCompletedBody');
  const clearMyCompletedBtn = document.getElementById('clearMyCompleted');

  // Local "My Completed" tracker
  const MYC_KEY = 'myCompleted.v1';
  function loadMyCompleted(){
    try{ return JSON.parse(localStorage.getItem(MYC_KEY)) || []; }catch{ return []; }
  }
  function saveMyCompleted(list){
    localStorage.setItem(MYC_KEY, JSON.stringify(list.slice(0, 200)));
  }
  function pushMyCompleted(row){
    const list = loadMyCompleted();
    list.unshift({
      when: Date.now(),
      partNumber: row.partNumber || '',
      printName: row.printName || '',
      expectedMinutes: row.expectedMinutes ?? null,
      notes: row.note || row.notes || ''
    });
    saveMyCompleted(list);
    renderMyCompleted();
  }
  function renderMyCompleted(){
    if (!myCompletedBody) return;
    const rows = loadMyCompleted();
    myCompletedBody.innerHTML = '';
    rows.forEach(r=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${new Date(r.when).toLocaleString()}</td>
        <td>${r.partNumber||''}</td>
        <td>${r.printName||''}</td>
        <td>${r.expectedMinutes!=null ? (r.expectedMinutes/60) : ''}</td>
        <td>${(r.notes||'').toString().replace(/\n/g,' ')}</td>`;
      myCompletedBody.appendChild(tr);
    });
  }
  if (clearMyCompletedBtn) clearMyCompletedBtn.addEventListener('click', ()=>{ saveMyCompleted([]); renderMyCompleted(); });

  // Submit new log (Start)
  if (submitLogBtn && partSelect) {
    submitLogBtn.addEventListener('click', async ()=>{
      const pn = partSelect.value;
      if (!pn){ alert('Select a part.'); return; }
      const opt = partSelect.selectedOptions[0];
      const printName = opt?.dataset?.print || '';
      const expectedMinutes = opt?.dataset?.hours ? Math.round(parseFloat(opt.dataset.hours)*60) : null;
      const notes = opt?.dataset?.notes || '';

      submitLogBtn.disabled = true; submitLogBtn.textContent = 'Starting...';
      try{
        await jobsApi(`/log`, {
          method:'POST',
          body: JSON.stringify({
            username: username(),
            partNumber: pn,
            action: 'Start',
            note: printName ? `From dashboard • ${printName}${notes ? ' • ' + notes : ''}` : (notes || ''),
            startTime: Date.now(),
            expectedMinutes
          })
        });

        // Sync assignment to InProgress for this part
        await maybeMarkAssignmentInProgress(username(), pn);

        // Reset UI and reload
        partSelect.value = '';
        fillInfoFromPart('');
        await requestRefresh(true);
      }catch(err){
        console.error(err);
        alert('Failed to start log.');
      }finally{
        submitLogBtn.disabled = false; submitLogBtn.textContent = 'Start';
      }
    });
  }

  // Render my active logs
  async function fetchMyLogs(){
    // pull all then filter by current user
    const rows = await jobsApi('/logs', { method:'GET' });
    return Array.isArray(rows) ? rows.filter(r => String(r.username||'') === username()) : [];
  }
  async function renderMyLogs(){
    if (!logTbody) return;
    let rows = [];
    try { rows = await fetchMyLogs(); } catch { rows = []; }

    logTbody.innerHTML = '';
    const now = Date.now();
    rows.forEach(r=>{
      const tr = document.createElement('tr');
      tr.dataset.id = r.id;
      tr.dataset.pn = r.partNumber || '';
      tr.innerHTML = `
        <td class="part">
          <a href="#" class="part-link" data-pn="${r.partNumber||''}">${r.partNumber||''}</a>
        </td>
        <td class="note">
          <input class="note-input" type="text" value="${(r.note||'').toString().replace(/"/g,'&quot;')}" />
        </td>
        <td class="act">
          ${
            r.endTime ? '<span class="muted">Finished</span>' :
            r.pauseStart ? `
              <button class="btn3d small" data-act="Continue" data-id="${r.id}">Continue</button>
              <button class="btn3d small danger" data-act="Finish" data-id="${r.id}">Finish</button>
            ` : `
              <button class="btn3d small" data-act="Pause" data-id="${r.id}">Pause</button>
              <button class="btn3d small danger" data-act="Finish" data-id="${r.id}">Finish</button>
            `
          }
        </td>
        <td class="started">${r.startTime ? new Date(r.startTime).toLocaleString() : ''}</td>
        <td class="dur" data-start="${r.startTime||''}" data-end="${r.endTime||''}" data-pause-start="${r.pauseStart||''}" data-pause-total="${r.pauseTotal||''}">
          ${fmtDuration(r.startTime, r.endTime, r.pauseStart, r.pauseTotal)}
        </td>
      `;
      logTbody.appendChild(tr);
    });
  }

  // Poller
  let pollTimer = null;
  async function requestRefresh(restart=false){
    await renderMyLogs();
    if (restart) {
      clearInterval(pollTimer);
      pollTimer = setInterval(async ()=>{
        // update durations live
        document.querySelectorAll('#logTableBody .dur').forEach(td=>{
          const s = Number(td.getAttribute('data-start')) || 0;
          const e = Number(td.getAttribute('data-end'))   || 0;
          const ps= Number(td.getAttribute('data-pause-start')) || 0;
          const pt= Number(td.getAttribute('data-pause-total')) || 0;
          td.textContent = fmtDuration(s, e, ps, pt);
        });
      }, 1000);
    }
  }

  // Actions in live table
  if (logTbody) {
    logTbody.addEventListener('click', async (e)=>{
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.dataset.id;
      const act = btn.dataset.act; // Pause | Continue | Finish
      btn.disabled = true;

      try{
        await jobsApi(`/log/${id}`, { method:'PATCH', body: JSON.stringify({ action: act, at: Date.now() }) });

        // If finished: mirror to assignments and push to "My Completed"
        if (act === 'Finish') {
          // fetch the row to know PN and note; fall back to DOM if needed
          let pn = '';
          try {
            const all = await fetchMyLogs();
            const row = all.find(r => String(r.id) === String(id));
            pn = row?.partNumber || '';
            pushMyCompleted({
              partNumber: row?.partNumber,
              printName: row?.printName,
              expectedMinutes: row?.expectedMinutes,
              note: row?.note
            });
          } catch {
            const tr = btn.closest('tr');
            pn = tr?.dataset?.pn || '';
            // push minimal if we had to
            pushMyCompleted({ partNumber: pn, printName:'', expectedMinutes:null, note:'' });
          }

          // Complete the assignment for this user+part
          if (pn) await maybeMarkAssignmentCompleted(username(), pn);
        }
      }catch(err){
        console.error(err);
        alert(`Failed to ${act}.`);
      }finally{
        await renderMyLogs();
        btn.disabled = false;
      }
    });

    // Update note on blur
    logTbody.addEventListener('change', async (e)=>{
      const input = e.target.closest('.note-input'); if (!input) return;
      const tr = input.closest('tr'); if (!tr) return;
      const id = tr.dataset.id;
      try{
        await jobsApi(`/log/${id}`, { method:'PATCH', body: JSON.stringify({ note: input.value }) });
      }catch{}
    });
  }

  // Delete all logs (if present; admin-only on backend, so may fail for techs)
  if (deleteAllBtn) {
    deleteAllBtn.addEventListener('click', async ()=>{
      if (!confirm('Delete ALL live logs?')) return;
      try{
        await jobsApi(`/admin/clear-logs`, { method:'DELETE' });
        await renderMyLogs();
      }catch(err){ alert('Failed to clear logs.'); }
    });
  }

  // Boot dashboard
  renderMyCompleted();
  requestRefresh(true);
});
