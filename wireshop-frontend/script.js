// script.js — stable selection + change-based refresh + focus-safe polling
document.addEventListener('DOMContentLoaded', () => {
  const API_URL = 'https://wireshop-backend.onrender.com/api/jobs';

  // --------- Shared helpers ---------
  const getUser = () => { try { return JSON.parse(localStorage.getItem('user')) || null; } catch { return null; } };
  const setUser = (u) => localStorage.setItem('user', JSON.stringify(u));
  const clearUser = () => localStorage.removeItem('user');
  const username = () => (getUser()?.username || '');

  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', 'x-user': username() };
    const res = await fetch(`${API_URL}${path}`, { headers, ...options });
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

  // Inject upgraded 3D button styles (stronger colors, crisper shadows)
  (function inject3D(){
    const css = `
      .btn3d{
        appearance:none; border:1px solid transparent; border-radius:12px;
        padding:7px 12px; font-weight:700; cursor:pointer; letter-spacing:.2px;
        box-shadow:0 3px 0 rgba(0,0,0,.28), 0 10px 18px rgba(0,0,0,.10);
        transition:transform .06s ease, box-shadow .06s ease, filter .15s ease, opacity .15s ease;
        text-shadow:0 1px 0 rgba(255,255,255,.35);
      }
      .btn3d.small{ font-size:.9rem; line-height:1 }
      .btn3d:active{ transform:translateY(1px); box-shadow:0 1px 0 rgba(0,0,0,.28), 0 6px 12px rgba(0,0,0,.14) }
      .btn3d:focus-visible{ outline:2px solid #005bd3; outline-offset:2px }

      /* Color themes with subtle gradients and hard edge for 3D rim */
      .btn3d.pause{
        color:#4a2a00; background:linear-gradient(#ffd99a, #ffb44a);
        border-color:#e0902d;
      }
      .btn3d.pause:hover{ filter:brightness(0.98) }
      .btn3d.continue{
        color:#0f4a2d; background:linear-gradient(#bff3d3, #4fd08a);
        border-color:#2fb26f;
      }
      .btn3d.continue:hover{ filter:brightness(0.98) }
      .btn3d.finish{
        color:#5a0e12; background:linear-gradient(#ffc5c5, #ff6e6e);
        border-color:#e24a4a;
      }
      .btn3d.finish:hover{ filter:brightness(0.98) }

      .btn3d[disabled]{
        opacity:.55; cursor:not-allowed; filter:none;
        box-shadow:0 2px 0 rgba(0,0,0,.12), 0 4px 8px rgba(0,0,0,.06);
      }

      .btn-group{ display:flex; gap:.5rem; align-items:center }
      .actions-cell{ min-width:240px }
      .notes-box{ min-width:240px }
      .row-selected{ outline:2px solid #0072ff33 }
    `;
    const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
  })();

  // ---------- LOGIN ----------
  (function initLogin(){
    const form = document.getElementById('login-form');
    if (!form) return;
    const err = document.getElementById('error-message');

    form.addEventListener('submit', (e)=>{
      e.preventDefault();
      const uname = (document.getElementById('usernameInput').value || '').trim().toLowerCase();
      const pin = (document.getElementById('pinInput').value || '').trim();

      const u = (window.users || []).find(x =>
        x && typeof x.username === 'string' &&
        x.username.toLowerCase() === uname &&
        String(x.pin) === String(pin)
      );
      if (!u){ if (err) err.textContent='Invalid username or PIN.'; return; }
      err.textContent='';
      setUser(u);
      window.location.href='dashboard.html';
    });
  })();

  // ---------- DASHBOARD ----------
  (function initDashboard(){
    const startBtn = document.getElementById('submitLog');
    if (!startBtn) return; // not on this page

    const user = getUser();
    if (!user) { window.location.href = 'index.html'; return; }

    const liveBtn = document.getElementById('liveViewBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const deleteAllBtn = document.getElementById('deleteAllLogs');

    const isAdmin = String(user.role || '').toLowerCase() === 'admin';
    if (!isAdmin) { liveBtn && (liveBtn.style.display='none'); deleteAllBtn && (deleteAllBtn.style.display='none'); }

    liveBtn?.addEventListener('click', ()=> window.location.href='admin.html');
    logoutBtn?.addEventListener('click', ()=> { clearUser(); window.location.href='index.html'; });

    const partSelect = document.getElementById('partSelect');
    const tBody = document.getElementById('logTableBody');

    const expTime = document.getElementById('expectedTime');
    const expNotes = document.getElementById('expectedNotes');
    const expLoc = document.getElementById('expectedLocation');
    const expSA = document.getElementById('expectedSA');

    // Populate parts
    function loadParts(){
      const items = Array.isArray(window.catalog) ? [...window.catalog] : [];
      items.sort((a,b)=> String(a.partNumber).localeCompare(String(b.partNumber)));
      partSelect.innerHTML = `<option value="">-- Select Part --</option>` +
        items.map(p => `<option value="${p.partNumber}">${p.partNumber} — ${p.printName || ''}</option>`).join('');
    }
    loadParts();

    // Info panel from part number
    function fillInfoFromPart(partNumber){
      const rec = (window.catalog || []).find(p => p.partNumber === partNumber);
      if (rec){
        partSelect.value = rec.partNumber; // reflect selection
        expTime.textContent = rec.expectedHours != null ? rec.expectedHours : '--';
        expNotes.textContent = rec.notes || '--';
        expLoc.textContent = rec.location || '--';
        expSA.textContent = rec.saNumber || '--';
      }else{
        expTime.textContent = '--'; expNotes.textContent='--'; expLoc.textContent='--'; expSA.textContent='--';
      }
    }

    partSelect.addEventListener('change', ()=> fillInfoFromPart(partSelect.value));

    // Start job
    startBtn.addEventListener('click', async ()=>{
      const pn = partSelect.value;
      if (!pn){ alert('Please select a part.'); return; }
      try{
        await api(`/log`, {
          method:'POST',
          body: JSON.stringify({
            username: user.username,
            partNumber: pn,
            action: 'Start',
            startTime: Date.now()
          })
        });
        partSelect.value='';
        fillInfoFromPart('');
        await requestRefresh(true); // force a refresh after starting
      }catch(err){
        console.error(err); alert('Failed to start job.');
      }
    });

    // Draft notes storage
    const draftKey = (logId)=> `draftNotes:${user.username}:${logId}`;
    const getDraft = (logId)=> localStorage.getItem(draftKey(logId)) || '';
    const setDraft = (logId, val)=> localStorage.setItem(draftKey(logId), val);
    const clearDraft = (logId)=> localStorage.removeItem(draftKey(logId));

    // --- Selection state (persistent) ---
    let selectedLogId = null;
    function highlightById(id){
      tBody.querySelectorAll('tr').forEach(r => r.classList.toggle('row-selected', r.dataset.id === id));
    }
    function selectRow(tr, log){
      selectedLogId = log?.id || null;
      highlightById(selectedLogId);
      fillInfoFromPart(log?.partNumber || '');
    }

    // Focus guard
    let isInteracting = false;
    const beginInteraction = ()=> { isInteracting = true; };
    const endInteraction = ()=> {
      const activeInside = tBody.contains(document.activeElement);
      if (!activeInside) isInteracting = false;
    };
    tBody.addEventListener('focusin', beginInteraction);
    tBody.addEventListener('focusout', () => setTimeout(endInteraction, 0));

    // Click anywhere in row to select
    tBody.addEventListener('mousedown', (e)=>{
      const tr = e.target.closest('tr');
      if (!tr) return;
      const id = tr.dataset.id;
      const partNumber = tr.querySelector('td')?.textContent.trim() || '';
      selectRow(tr, { id, partNumber });
    }, true);

    // ---- Change-aware refresh ----
    let lastSig = ''; // signature of active jobs from backend

    function makeSignature(rows){
      const minimal = rows
        .filter(r => !r.endTime)
        .map(r => ({
          id: r.id, partNumber: r.partNumber, action: r.action,
          startTime: r.startTime, endTime: r.endTime,
          pauseStart: r.pauseStart, pauseTotal: r.pauseTotal
        }));
      return JSON.stringify(minimal);
    }

    // Action buttons (delegated)
    tBody.addEventListener('click', async (e)=>{
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const tr = btn.closest('tr'); if (!tr) return;
      const logId = Number(tr.dataset.id);
      const act = btn.getAttribute('data-act');

      const group = tr.querySelectorAll('button[data-act]');
      group.forEach(b=> b.disabled = true);

      try{
        const body = { action: act };
        if (act === 'Finish'){
          body.endTime = Date.now();
          const latestDraft = tr.querySelector('textarea.notes-box')?.value.trim();
          if (latestDraft) body.note = latestDraft;
        }
        await api(`/log/${logId}`, { method:'PUT', body: JSON.stringify(body) });

        if (act === 'Finish'){
          clearDraft(logId);
          if (selectedLogId === logId){ selectedLogId = null; fillInfoFromPart(''); }
          await requestRefresh(true);
        } else {
          lastSig = '';
        }
      }catch(err){
        console.error(err); alert('Failed to update action.');
      }finally{
        group.forEach(b=> b.disabled = false);
      }
    });

    async function refreshActive(force = false){
      if (isInteracting && !force) return;

      const rows = await api(`/logs/${encodeURIComponent(user.username)}`, { method:'GET' });
      const active = rows.filter(r => !r.endTime);
      const sig = makeSignature(rows);

      if (!force && sig === lastSig) return;
      lastSig = sig;

      const prevScroll = tBody.parentElement?.scrollTop ?? 0;

      tBody.innerHTML = '';
      active.forEach(log=>{
        const tr = document.createElement('tr');
        tr.dataset.id = log.id;

        const draft = getDraft(log.id) || log.note || '';
        const current = (log.action || '').trim();
        const logicalState = (current === 'Pause' || current === 'Finish') ? current : 'Continue';

        tr.innerHTML = `
          <td>${log.partNumber || ''}</td>
          <td>
            <textarea class="notes-box" data-id="${log.id}" placeholder="Type notes...">${draft}</textarea>
          </td>
          <td class="actions-cell">
            <div class="btn-group">
              <button class="btn3d small pause" data-act="Pause" ${logicalState==='Pause'?'disabled':''}>Pause</button>
              <button class="btn3d small continue" data-act="Continue" ${logicalState==='Continue'?'disabled':''}>Continue</button>
              <button class="btn3d small finish" data-act="Finish">Finish</button>
            </div>
          </td>
          <td>${log.startTime ? new Date(log.startTime).toLocaleString() : ''}</td>
          <td class="dur" data-start="${log.startTime || ''}" data-pause="${log.pauseStart || ''}" data-paused="${log.pauseTotal || 0}">${fmtDuration(log.startTime, log.endTime, log.pauseStart, log.pauseTotal)}</td>
        `;

        tr.querySelector('textarea.notes-box').addEventListener('input', (e)=> setDraft(log.id, e.target.value));
        tBody.appendChild(tr);
      });

      if (selectedLogId && active.some(r => r.id === selectedLogId)){
        highlightById(selectedLogId);
        const log = active.find(r => r.id === selectedLogId);
        fillInfoFromPart(log?.partNumber || '');
      } else if (selectedLogId){
        selectedLogId = null;
        fillInfoFromPart('');
      }

      if (tBody.parentElement) tBody.parentElement.scrollTop = prevScroll;
    }

    async function requestRefresh(force = false){
      await refreshActive(force);
    }

    // Tick durations
    function tickDurations(){
      tBody.querySelectorAll('.dur').forEach(td=>{
        const start = Number(td.getAttribute('data-start')) || 0;
        const pauseStart = Number(td.getAttribute('data-pause')) || 0;
        const pauseTotal = Number(td.getAttribute('data-paused')) || 0;
        td.textContent = fmtDuration(start, null, pauseStart, pauseTotal);
      });
    }

    // Delete all
    deleteAllBtn?.addEventListener('click', async ()=>{
      if (!confirm('Delete ALL your logs?')) return;
      try{ await api(`/delete-logs/${encodeURIComponent(user.username)}`, { method:'DELETE' }); lastSig=''; tBody.innerHTML=''; fillInfoFromPart(''); }
      catch(err){ console.error(err); alert('Failed to delete logs.'); }
    });

    // Initial + polling
    requestRefresh(true).catch(console.error);
    setInterval(()=> requestRefresh(false), 5000);
    setInterval(tickDurations, 1000);
  })();

  // ---------- ADMIN ----------
  (function initAdmin(){
    const backBtn = document.getElementById('backToDashboard');
    const tbody = document.getElementById('activityTableBody');
    if (!backBtn && !tbody) return;

    const user = getUser();
    if (!user) { window.location.href='index.html'; return; }
    const isAdmin = String(user.role || '').toLowerCase() === 'admin';
    if (!isAdmin){ window.location.href='dashboard.html'; return; }

    backBtn?.addEventListener('click', ()=> window.location.href='dashboard.html');

    const clearAll = document.getElementById('clearAllLogs');
    clearAll?.addEventListener('click', async ()=>{
      if (!confirm('Clear ALL logs for ALL users?')) return;
      try{ await api(`/admin/clear-logs`, { method:'DELETE' }); await fetchAll(); }
      catch(err){ console.error(err); alert('Failed to clear logs.'); }
    });

    const catByPart = new Map((window.catalog || []).map(p => [String(p.partNumber), p]));
    const fmtExpected = (hours) => {
      if (hours == null) return '';
      const mins = Math.round(Number(hours) * 60);
      const h = Math.floor(mins/60), m = mins % 60;
      return `${h}:${String(m).padStart(2,'0')}`;
    };

    async function fetchAll(){
      try{
        const rows = await api(`/logs`, { method:'GET' });
        tbody.innerHTML='';
        rows.forEach(log=>{
          const cat = catByPart.get(String(log.partNumber)) || {};
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>${log.username || ''}</td>
            <td>${log.partNumber || ''}</td>
            <td>${cat.printName || ''}</td>
            <td>${fmtExpected(cat.expectedHours)}</td>
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
