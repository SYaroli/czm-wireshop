// script.js — robust login + dashboard + assignment sync (un-compacted, backward-compatible)
document.addEventListener('DOMContentLoaded', () => {
  const API_ROOT   = 'https://wireshop-backend.onrender.com';
  const API_JOBS   = `${API_ROOT}/api/jobs`;
  const API_ASSIGN = `${API_ROOT}/api/assignments`;
  const API_USERS  = `${API_ROOT}/api/users`;

  // ------------------- shared helpers -------------------
  const getUser   = () => { try { return JSON.parse(localStorage.getItem('user')) || null; } catch { return null; } };
  const setUser   = (u) => localStorage.setItem('user', JSON.stringify(u));
  const clearUser = () => localStorage.removeItem('user');
  const username  = () => (getUser()?.username || '');

  async function apiFetch(url, options = {}) {
    const headers = { 'Content-Type': 'application/json', 'x-user': username() };
    const res = await fetch(url, { headers, ...options });
    if (!res.ok) {
      let msg = '';
      try { msg = await res.text(); } catch {}
      throw new Error(`HTTP ${res.status} ${res.statusText}${msg ? ` - ${msg}` : ''}`);
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

  // ------------------- LOGIN PAGE (supports both forms) -------------------
  const loginForm = document.getElementById('login-form') || document.getElementById('loginForm');
  if (loginForm) {
    // accept both id sets
    const $u = document.getElementById('usernameInput') || document.getElementById('username');
    const $p = document.getElementById('pinInput')       || document.getElementById('pin');
    const $err = document.getElementById('error-message') || document.getElementById('errorMessage');

    async function usersLogin(uname, pin){
      // no x-user on login, some servers choke on it
      const res = await fetch(`${API_USERS}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: uname, pin })
      });
      if (!res.ok) throw new Error('bad creds');
      return res.json();
    }

    loginForm.addEventListener('submit', async (e)=>{
      e.preventDefault();
      if ($err) $err.textContent = '';
      const uname = ($u?.value || '').trim();
      const pin   = ($p?.value || '').trim();
      if (!uname || !pin) { if ($err) $err.textContent = 'Enter username and PIN.'; return; }
      try{
        const data = await usersLogin(uname, pin);
        setUser({ username: data.username, role: data.role });
        window.location.href = 'dashboard.html';
      }catch{
        if ($err) $err.textContent = 'Invalid username or PIN.';
      }
    });

    // Login page doesn’t need dashboard code
    return;
  }

  // ------------------- DASHBOARD (dashboard.html) -------------------
  // Must be logged in to be here
  if (!getUser()) { window.location.href = 'index.html'; return; }

  // header actions
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', ()=>{ clearUser(); window.location.href='index.html'; });

  // Part picker + info
  const partSelect      = document.getElementById('partSelect');
  const expectedTimeEl  = document.getElementById('expectedTime');
  const expectedSAEl    = document.getElementById('expectedSA');
  const expectedLocEl   = document.getElementById('expectedLocation');
  const expectedNotesEl = document.getElementById('expectedNotes');
  const submitLogBtn    = document.getElementById('submitLog');

  function getCatalog(){ return Array.isArray(window.catalog) ? window.catalog : []; }
  function partByPN(pn){ return getCatalog().find(p => String(p.partNumber) === String(pn)); }

  function fillInfoFromPart(pn){
    const p = partByPN(pn) || {};
    if (expectedTimeEl) expectedTimeEl.textContent  = typeof p.expectedHours === 'number' ? `${p.expectedHours}` : '--';
    if (expectedSAEl)   expectedSAEl.textContent    = p.saNumber ?? '--';
    if (expectedLocEl)  expectedLocEl.textContent   = p.location ?? '--';
    if (expectedNotesEl)expectedNotesEl.textContent = p.notes ?? '--';
  }

  if (partSelect) {
    // Build dropdown once
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

    partSelect.innerHTML = '<option value="">-- Select Part --</option>';
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

  // ------------------- assignments sync helpers -------------------
  async function findAssignment(user, partNumber, status) {
    try{
      const qs = `?username=${encodeURIComponent(user)}&status=${encodeURIComponent(status)}`;
      const rows = await assignApi(qs, { method: 'GET' });
      if (!Array.isArray(rows)) return null;
      const matches = rows.filter(r => String(r.partNumber||'') === String(partNumber||''));
      if (!matches.length) return null;
      matches.sort((a,b)=> (a.createdAt||0) - (b.createdAt||0)); // earliest
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

  // ------------------- My Completed (local list) -------------------
  const myCompletedBody    = document.getElementById('myCompletedBody');
  const clearMyCompletedBtn= document.getElementById('clearMyCompleted');
  const MYC_KEY = 'myCompleted.v1';

  function loadMyCompleted(){ try{ return JSON.parse(localStorage.getItem(MYC_KEY)) || []; }catch{ return []; } }
  function saveMyCompleted(list){ localStorage.setItem(MYC_KEY, JSON.stringify(list.slice(0, 200))); }
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
        <td><button class="danger" data-del="1">Delete</button></td>`;
      myCompletedBody.appendChild(tr);
    });
  }
  if (clearMyCompletedBtn) clearMyCompletedBtn.addEventListener('click', ()=>{ saveMyCompleted([]); renderMyCompleted(); });
  if (myCompletedBody) myCompletedBody.addEventListener('click', (e)=>{
    const btn = e.target.closest('button[data-del]'); if (!btn) return;
    const rows = loadMyCompleted(); rows.shift(); saveMyCompleted(rows); renderMyCompleted();
  });

  // ------------------- Live logs (mine) -------------------
  const logTbody = document.getElementById('logTableBody');

  async function fetchMyLogs(){
    const rows = await jobsApi('/logs', { method:'GET' });
    return Array.isArray(rows) ? rows.filter(r => String(r.username||'') === username()) : [];
  }
  async function renderMyLogs(){
    if (!logTbody) return;
    let rows = [];
    try { rows = await fetchMyLogs(); } catch { rows = []; }

    logTbody.innerHTML = '';
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

  // Update durations every second
  let ticker = null;
  async function requestRefresh(restart=false){
    await renderMyLogs();
    if (restart) {
      clearInterval(ticker);
      ticker = setInterval(()=>{
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

  // Start from part picker
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

        // Sync assignment to InProgress
        await maybeMarkAssignmentInProgress(username(), pn);

        // Reset and refresh
        partSelect.value = '';
        fillInfoFromPart('');
        await requestRefresh(true);
      }catch(err){
        console.error(err);
        alert('Failed to start log.');
      }finally{
        submitLogBtn.disabled = false; submitLogBtn.textContent = 'Start Job';
      }
    });
  }

  // Click handlers inside live table
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
            pushMyCompleted({ partNumber: pn, printName:'', expectedMinutes:null, note:'' });
          }

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

    // Save note on change
    logTbody.addEventListener('change', async (e)=>{
      const input = e.target.closest('.note-input'); if (!input) return;
      const tr = input.closest('tr'); if (!tr) return;
      const id = tr.dataset.id;
      try{
        await jobsApi(`/log/${id}`, { method:'PATCH', body: JSON.stringify({ note: input.value }) });
      }catch{}
    });
  }

  // Kick everything off
  renderMyCompleted();
  requestRefresh(true);
});
