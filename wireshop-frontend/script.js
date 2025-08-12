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

    // Start job (no notes here; notes live in active rows)
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

    // Focus guard: pause refresh only while editing/using controls (not hover-based)
    let isInteracting = false;
    const beginInteraction = ()=> { isInteracting = true; };
    const endInteraction = ()=> {
      // if focus moved outside the table, resume
      const activeInside = tBody.contains(document.activeElement);
      if (!activeInside) isInteracting = false;
    };
    tBody.addEventListener('focusin', beginInteraction);
    tBody.addEventListener('focusout', () => setTimeout(endInteraction, 0));

    // Click anywhere in row (including controls) to select
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
      // Only fields that affect rendering; ignore text in textarea (we use drafts)
      const minimal = rows
        .filter(r => !r.endTime)
        .map(r => ({
          id: r.id, partNumber: r.partNumber, action: r.action,
          startTime: r.startTime, endTime: r.endTime,
          pauseStart: r.pauseStart, pauseTotal: r.pauseTotal
        }));
      return JSON.stringify(minimal);
    }

    async function refreshActive(force = false){
      if (isInteracting && !force) return; // don't disrupt typing or open selects

      const rows = await api(`/logs/${encodeURIComponent(user.username)}`, { method:'GET' });
      const active = rows.filter(r => !r.endTime);
      const sig = makeSignature(rows);

      // If nothing changed and not forced, skip DOM work
      if (!force && sig === lastSig) return;
      lastSig = sig;

      // Preserve scroll
      const prevScroll = tBody.parentElement?.scrollTop ?? 0;

      // Rebuild rows (simple and safe); selection restored below
      tBody.innerHTML = '';
      active.forEach(log=>{
        const tr = document.createElement('tr');
        tr.dataset.id = log.id;

        const draft = getDraft(log.id) || log.note || '';

        tr.innerHTML = `
          <td>${log.partNumber || ''}</td>
          <td>
            <textarea class="notes-box" data-id="${log.id}" placeholder="Type notes...">${draft}</textarea>
          </td>
          <td>
            <select class="row-action" data-id="${log.id}" data-part="${log.partNumber}">
              <option value="Pause" class="row-pause">Pause</option>
              <option value="Continue" class="row-continue">Continue</option>
              <option value="Finish" class="row-finish">Finish</option>
            </select>
          </td>
          <td>${log.startTime ? new Date(log.startTime).toLocaleString() : ''}</td>
          <td class="dur" data-start="${log.startTime || ''}" data-pause="${log.pauseStart || ''}" data-paused="${log.pauseTotal || 0}">${fmtDuration(log.startTime, log.endTime, log.pauseStart, log.pauseTotal)}</td>
        `;

        // current state -> dropdown
        const sel = tr.querySelector('select.row-action');
        const current = (log.action || '').trim();
        sel.value = (current === 'Pause' || current === 'Finish') ? current : 'Continue';

        // notes draft tracking (doesn't hit backend until Finish)
        tr.querySelector('textarea.notes-box').addEventListener('input', (e)=> setDraft(log.id, e.target.value));

        // action changes -> PUT; on Finish remove row and clear draft
        sel.addEventListener('change', async (e)=>{
          const next = e.target.value;
          try{
            const body = { action: next };
            if (next === 'Finish'){
              body.endTime = Date.now();
              const latestDraft = tr.querySelector('textarea.notes-box').value.trim();
              if (latestDraft) body.note = latestDraft;
            }
            await api(`/log/${log.id}`, { method:'PUT', body: JSON.stringify(body) });

            if (next === 'Finish'){
              clearDraft(log.id);
              if (selectedLogId === log.id){ selectedLogId = null; fillInfoFromPart(''); }
              // Force-refresh now that data changed
              await requestRefresh(true);
            } else {
              sel.value = next;
              // force signature change so next poll updates durations if needed
              lastSig = ''; 
            }
          }catch(err){
            console.error(err); alert('Failed to update action.');
          }
        });

        tBody.appendChild(tr);
      });

      // restore selection if still present
      if (selectedLogId && active.some(r => r.id === selectedLogId)){
        highlightById(selectedLogId);
        const log = active.find(r => r.id === selectedLogId);
        fillInfoFromPart(log?.partNumber || '');
      } else if (selectedLogId){
        // selected row no longer exists
        selectedLogId = null;
        fillInfoFromPart('');
      }

      // restore scroll
      if (tBody.parentElement) tBody.parentElement.scrollTop = prevScroll;
    }

    async function requestRefresh(force = false){
      await refreshActive(force);
    }

    // Tick durations (safe: only text changes)
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
    requestRefresh(true).catch(console.error);          // first render forced
    setInterval(()=> requestRefresh(false), 5000);      // change-aware poll
    setInterval(tickDurations, 1000);                   // smooth timer
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

    // Catalog lookups for Print Name + Expected
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
