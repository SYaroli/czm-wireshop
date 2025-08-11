// script.js — streamlined dashboard with live notes + row selection -> info panel
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
        await refreshActive();
      }catch(err){
        console.error(err); alert('Failed to start job.');
      }
    });

    // Draft notes storage
    const draftKey = (logId)=> `draftNotes:${user.username}:${logId}`;
    const getDraft = (logId)=> localStorage.getItem(draftKey(logId)) || '';
    const setDraft = (logId, val)=> localStorage.setItem(draftKey(logId), val);
    const clearDraft = (logId)=> localStorage.removeItem(draftKey(logId));

    // Selection tracking
    let selectedLogId = null;

    function applySelection(tr){
      tBody.querySelectorAll('tr.row-selected').forEach(r => r.classList.remove('row-selected'));
      if (tr){ tr.classList.add('row-selected'); }
    }

    function selectByPart(partNumber, tr, logId){
      selectedLogId = logId || null;
      applySelection(tr || null);
      fillInfoFromPart(partNumber || '');
    }

    // Event delegation for row selection (click anywhere in row, including controls)
    tBody.addEventListener('mousedown', (e)=>{
      const tr = e.target.closest('tr');
      if (!tr) return;
      const partNumber = (tr.querySelector('td')?.textContent || '').trim();
      const logId = tr.dataset.id || null;
      selectByPart(partNumber, tr, logId);
    }, true);

    // Render active logs (no endTime)
    async function refreshActive(){
      const rows = await api(`/logs/${encodeURIComponent(user.username)}`, { method:'GET' });
      const active = rows.filter(r => !r.endTime);
      const prevSelected = selectedLogId;

      tBody.innerHTML='';
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

        // current state
        const sel = tr.querySelector('select.row-action');
        const current = (log.action || '').trim();
        sel.value = (current === 'Pause' || current === 'Finish') ? current : 'Continue';

        // notes draft tracking
        tr.querySelector('textarea.notes-box').addEventListener('input', (e)=> setDraft(log.id, e.target.value));

        // action changes
        sel.addEventListener('change', async (e)=>{
          const next = e.target.value;
          try{
            const body = { action: next };
            if (next === 'Finish'){
              body.endTime = Date.now();
              const latestDraft = tr.querySelector('textarea.notes-box').value.trim();
              if (latestDraft) body.note = latestDraft; // commit note only at finish
            }
            await api(`/log/${log.id}`, { method:'PUT', body: JSON.stringify(body) });

            if (next === 'Finish'){
              clearDraft(log.id);
              if (selectedLogId === log.id) { selectedLogId = null; fillInfoFromPart(''); }
              tr.remove();
            } else {
              e.target.value = next;
            }
          }catch(err){
            console.error(err); alert('Failed to update action.');
          }
        });

        // restore selection after refresh
        if (prevSelected && log.id === prevSelected){
          applySelection(tr);
          fillInfoFromPart(log.partNumber || '');
        }

        tBody.appendChild(tr);
      });

      // if previous selected row vanished, clear panel
      if (prevSelected && !active.find(r => r.id === prevSelected)){
        selectedLogId = null;
        fillInfoFromPart('');
      }
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
      try{ await api(`/delete-logs/${encodeURIComponent(user.username)}`, { method:'DELETE' }); tBody.innerHTML=''; fillInfoFromPart(''); }
      catch(err){ console.error(err); alert('Failed to delete logs.'); }
    });

    refreshActive().catch(console.error);
    setInterval(async ()=>{ try{ await refreshActive(); }catch{} }, 5000);
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

    async function fetchAll(){
      try{
        const rows = await api(`/logs`, { method:'GET' });
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
