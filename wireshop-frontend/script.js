// script.js — JWT login + stable dashboard from earlier
document.addEventListener('DOMContentLoaded', () => {
  const API_URL = 'https://wireshop-backend.onrender.com/api';

  // ---- Auth store ----
  const getAuth = () => { try { return JSON.parse(localStorage.getItem('auth')) || null; } catch { return null; } };
  const setAuth = (obj) => localStorage.setItem('auth', JSON.stringify(obj));
  const clearAuth = () => localStorage.removeItem('auth');

  const getUser = () => getAuth()?.user || null;
  const token = () => getAuth()?.token || '';

  // ---- API helpers (Bearer token) ----
  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const t = token();
    if (t) headers['Authorization'] = `Bearer ${t}`;
    const res = await fetch(`${API_URL}${path}`, { ...options, headers });
    if (!res.ok) { const msg = await res.text().catch(()=> ''); throw new Error(`HTTP ${res.status} ${res.statusText} - ${msg}`); }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
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

  // ---------- LOGIN ----------
  (function initLogin(){
    const form = document.getElementById('login-form');
    if (!form) return;
    const err = document.getElementById('error-message');

    form.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const username = (document.getElementById('usernameInput').value || '').trim().toLowerCase();
      const pin = (document.getElementById('pinInput').value || '').trim();

      try {
        const data = await api('/users/login', {
          method: 'POST',
          body: JSON.stringify({ username, pin })
        });
        setAuth(data);            // { token, user: { id, username, role } }
        window.location.href='dashboard.html';
      } catch (ex) {
        console.error(ex);
        err.textContent = 'Invalid username or PIN.';
      }
    });
  })();

  // ---------- DASHBOARD ----------
  (function initDashboard(){
    const startBtn = document.getElementById('submitLog');
    if (!startBtn) return;

    const authUser = getUser();
    if (!authUser) { window.location.href = 'index.html'; return; }

    const liveBtn = document.getElementById('liveViewBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const deleteAllBtn = document.getElementById('deleteAllLogs');

    const isAdmin = String(authUser.role || '').toLowerCase() === 'admin';
    if (!isAdmin) { liveBtn && (liveBtn.style.display='none'); deleteAllBtn && (deleteAllBtn.style.display='none'); }

    liveBtn?.addEventListener('click', ()=> window.location.href='admin.html');
    logoutBtn?.addEventListener('click', ()=> { clearAuth(); window.location.href='index.html'; });

    const partSelect = document.getElementById('partSelect');
    const tBody = document.getElementById('logTableBody');

    const expTime = document.getElementById('expectedTime');
    const expNotes = document.getElementById('expectedNotes');
    const expLoc = document.getElementById('expectedLocation');
    const expSA = document.getElementById('expectedSA');

    function loadParts(){
      const items = Array.isArray(window.catalog) ? [...window.catalog] : [];
      items.sort((a,b)=> String(a.partNumber).localeCompare(String(b.partNumber)));
      partSelect.innerHTML = `<option value="">-- Select Part --</option>` +
        items.map(p => `<option value="${p.partNumber}">${p.partNumber} — ${p.printName || ''}</option>`).join('');
    }
    loadParts();

    function fillInfoFromPart(partNumber){
      const rec = (window.catalog || []).find(p => p.partNumber === partNumber);
      if (rec){
        partSelect.value = rec.partNumber;
        expTime.textContent = rec.expectedHours != null ? rec.expectedHours : '--';
        expNotes.textContent = rec.notes || '--';
        expLoc.textContent = rec.location || '--';
        expSA.textContent = rec.saNumber || '--';
      }else{
        expTime.textContent = '--'; expNotes.textContent='--'; expLoc.textContent='--'; expSA.textContent='--';
      }
    }

    partSelect.addEventListener('change', ()=> fillInfoFromPart(partSelect.value));

    startBtn.addEventListener('click', async ()=>{
      const pn = partSelect.value;
      if (!pn){ alert('Please select a part.'); return; }
      try{
        await api('/jobs/log', {
          method:'POST',
          body: JSON.stringify({
            partNumber: pn,
            action: 'Start',
            startTime: Date.now()
          })
        });
        partSelect.value=''; fillInfoFromPart('');
        await requestRefresh(true);
      }catch(err){
        console.error(err); alert('Failed to start job.');
      }
    });

    const draftKey = (id)=> `draftNotes:${authUser.username}:${id}`;
    const getDraft = (id)=> localStorage.getItem(draftKey(id)) || '';
    const setDraft = (id, val)=> localStorage.setItem(draftKey(id), val);
    const clearDraft = (id)=> localStorage.removeItem(draftKey(id));

    let selectedLogId = null;
    function highlightById(id){
      tBody.querySelectorAll('tr').forEach(r => r.classList.toggle('row-selected', r.dataset.id === id));
    }
    function selectRow(tr, log){
      selectedLogId = log?.id || null; highlightById(selectedLogId);
      fillInfoFromPart(log?.partNumber || '');
    }

    let isInteracting = false;
    const beginInteraction = ()=> { isInteracting = true; };
    const endInteraction = ()=> {
      const activeInside = tBody.contains(document.activeElement);
      if (!activeInside) isInteracting = false;
    };
    tBody.addEventListener('focusin', beginInteraction);
    tBody.addEventListener('focusout', () => setTimeout(endInteraction, 0));
    tBody.addEventListener('mousedown', (e)=>{
      const tr = e.target.closest('tr');
      if (!tr) return;
      const id = tr.dataset.id;
      const pn = tr.querySelector('td')?.textContent.trim() || '';
      selectRow(tr, { id, partNumber: pn });
    }, true);

    let lastSig = '';
    function sig(rows){
      return JSON.stringify(rows.filter(r=>!r.endTime).map(r=>({
        id:r.id, partNumber:r.partNumber, action:r.action,
        startTime:r.startTime, endTime:r.endTime,
        pauseStart:r.pauseStart, pauseTotal:r.pauseTotal
      })));
    }

    async function refreshActive(force=false){
      if (isInteracting && !force) return;
      const rows = await api(`/jobs/logs/${encodeURIComponent(authUser.username)}`, { method:'GET' });
      const active = rows.filter(r => !r.endTime);
      const s = sig(rows);
      if (!force && s === lastSig) return;
      lastSig = s;

      const prevScroll = tBody.parentElement?.scrollTop ?? 0;
      tBody.innerHTML = '';
      active.forEach(log=>{
        const tr = document.createElement('tr');
        tr.dataset.id = log.id;
        const draft = getDraft(log.id) || log.note || '';
        tr.innerHTML = `
          <td>${log.partNumber || ''}</td>
          <td><textarea class="notes-box" data-id="${log.id}" placeholder="Type notes...">${draft}</textarea></td>
          <td>
            <select class="row-action" data-id="${log.id}" data-part="${log.partNumber}">
              <option value="Pause" class="row-pause">Pause</option>
              <option value="Continue" class="row-continue">Continue</option>
              <option value="Finish" class="row-finish">Finish</option>
            </select>
          </td>
          <td>${log.startTime ? new Date(log.startTime).toLocaleString() : ''}</td>
          <td class="dur" data-start="${log.startTime||''}" data-pause="${log.pauseStart||''}" data-paused="${log.pauseTotal||0}">${fmtDuration(log.startTime, log.endTime, log.pauseStart, log.pauseTotal)}</td>
        `;
        const sel = tr.querySelector('select.row-action');
        const current = (log.action || '').trim();
        sel.value = (current === 'Pause' || current === 'Finish') ? current : 'Continue';
        tr.querySelector('textarea.notes-box').addEventListener('input', (e)=> setDraft(log.id, e.target.value));
        sel.addEventListener('change', async (e)=>{
          const next = e.target.value;
          try{
            const body = { action: next };
            if (next === 'Finish'){
              body.endTime = Date.now();
              const latestDraft = tr.querySelector('textarea.notes-box').value.trim();
              if (latestDraft) body.note = latestDraft;
            }
            await api(`/jobs/log/${log.id}`, { method:'PUT', body: JSON.stringify(body) });
            if (next === 'Finish'){ clearDraft(log.id); if (selectedLogId === log.id){ selectedLogId = null; fillInfoFromPart(''); } await requestRefresh(true); }
            else { sel.value = next; lastSig = ''; }
          }catch(err){ console.error(err); alert('Failed to update action.'); }
        });
        tBody.appendChild(tr);
      });

      if (selectedLogId && active.some(r => r.id === selectedLogId)){
        highlightById(selectedLogId);
        const log = active.find(r => r.id === selectedLogId);
        fillInfoFromPart(log?.partNumber || '');
      } else if (selectedLogId) {
        selectedLogId = null; fillInfoFromPart('');
      }
      if (tBody.parentElement) tBody.parentElement.scrollTop = prevScroll;
    }

    async function requestRefresh(force=false){ await refreshActive(force); }

    function tickDurations(){
      tBody.querySelectorAll('.dur').forEach(td=>{
        const start = Number(td.getAttribute('data-start')) || 0;
        const pauseStart = Number(td.getAttribute('data-pause')) || 0;
        const pauseTotal = Number(td.getAttribute('data-paused')) || 0;
        td.textContent = fmtDuration(start, null, pauseStart, pauseTotal);
      });
    }

    deleteAllBtn?.addEventListener('click', async ()=>{
      if (!confirm('Delete ALL your logs?')) return;
      try{ await api(`/jobs/delete-logs/${encodeURIComponent(authUser.username)}`, { method:'DELETE' }); lastSig=''; document.getElementById('logTableBody').innerHTML=''; fillInfoFromPart(''); }
      catch(err){ console.error(err); alert('Failed to delete logs.'); }
    });

    requestRefresh(true).catch(console.error);
    setInterval(()=> requestRefresh(false), 5000);
    setInterval(tickDurations, 1000);
  })();

  // ---------- ADMIN ----------
  (function initAdmin(){
    const backBtn = document.getElementById('backToDashboard');
    const tbody = document.getElementById('activityTableBody');
    if (!backBtn && !tbody) return;

    const authUser = getUser();
    if (!authUser) { window.location.href='index.html'; return; }
    const isAdmin = String(authUser.role || '').toLowerCase() === 'admin';
    if (!isAdmin){ window.location.href='dashboard.html'; return; }

    backBtn?.addEventListener('click', ()=> window.location.href='dashboard.html');

    const clearAll = document.getElementById('clearAllLogs');
    clearAll?.addEventListener('click', async ()=>{
      if (!confirm('Clear ALL logs for ALL users?')) return;
      try{ await api(`/jobs/admin/clear-logs`, { method:'DELETE' }); await fetchAll(); }
      catch(err){ console.error(err); alert('Failed to clear logs.'); }
    });

    async function fetchAll(){
      try{
        const rows = await api(`/jobs/logs`, { method:'GET' });
        tbody.innerHTML='';
        rows.forEach(log=>{
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>${log.username || ''}</td>
            <td>${log.partNumber || ''}</td>
            <td>${log.action || ''}</td>
            <td>${log.note || ''}</td>
            <td>${fmtDuration(log.startTime, log.endTime, log.pauseStart, log.pauseTotal)}</td>
          `;
          tbody.appendChild(tr);
        });
      }catch(err){ console.error(err); alert('Failed to load admin logs.'); }
    }

    fetchAll().catch(console.error);
    setInterval(fetchAll, 5000);
  })();
});
