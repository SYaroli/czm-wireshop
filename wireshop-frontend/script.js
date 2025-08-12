// script.js — login + dashboard with hard-freeze Pause (no visual jump)
document.addEventListener('DOMContentLoaded', () => {
  const API_ROOT = 'https://wireshop-backend.onrender.com';
  const API_JOBS = `${API_ROOT}/api/jobs`;

  // --------- Shared helpers ---------
  const getUser = () => { try { return JSON.parse(localStorage.getItem('user')) || null; } catch { return null; } };
  const setUser = (u) => localStorage.setItem('user', JSON.stringify(u));
  const clearUser = () => localStorage.removeItem('user');
  const username = () => (getUser()?.username || '');

  async function jobsApi(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', 'x-user': username() };
    const res = await fetch(`${API_JOBS}${path}`, { headers, ...options });
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

  // Stronger 3D buttons
  (function inject3D(){
    const css = `
      .btn3d{appearance:none;border:1px solid transparent;border-radius:12px;padding:7px 12px;font-weight:700;cursor:pointer;letter-spacing:.2px;
        box-shadow:0 3px 0 rgba(0,0,0,.28),0 10px 18px rgba(0,0,0,.10);transition:transform .06s, box-shadow .06s, filter .15s, opacity .15s;text-shadow:0 1px 0 rgba(255,255,255,.35);}
      .btn3d.small{font-size:.9rem;line-height:1}
      .btn3d:active{transform:translateY(1px);box-shadow:0 1px 0 rgba(0,0,0,.28),0 6px 12px rgba(0,0,0,.14)}
      .btn3d.pause{color:#4a2a00;background:linear-gradient(#ffd99a,#ffb44a);border-color:#e0902d}
      .btn3d.continue{color:#0f4a2d;background:linear-gradient(#bff3d3,#4fd08a);border-color:#2fb26f}
      .btn3d.finish{color:#5a0e12;background:linear-gradient(#ffc5c5,#ff6e6e);border-color:#e24a4a}
      .btn3d[disabled]{opacity:.55;cursor:not-allowed;box-shadow:0 2px 0 rgba(0,0,0,.12),0 4px 8px rgba(0,0,0,.06)}
      .btn-group{display:flex;gap:.5rem;align-items:center}.actions-cell{min-width:240px}.notes-box{min-width:240px}.row-selected{outline:2px solid #0072ff33}
    `;
    const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
  })();

  // ---------- LOGIN ----------
  (function initLogin(){
    const form = document.getElementById('login-form');
    if (!form) return;
    const err = document.getElementById('error-message');

    form.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const uname = (document.getElementById('usernameInput').value || '').trim();
      const pin   = (document.getElementById('pinInput').value || '').trim();

      // Try backend users first
      try{
        const res = await fetch(`${API_ROOT}/api/users/login`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ username: uname, pin })
        });
        if (res.ok){
          const data = await res.json();
          setUser({ username: data.username, role: data.role });
          window.location.href = 'dashboard.html'; return;
        }
      }catch{}

      // Fallback to static users.js
      const u = (window.users || []).find(x =>
        x && typeof x.username === 'string' &&
        x.username.toLowerCase() === uname.toLowerCase() &&
        String(x.pin) === String(pin)
      );
      if (!u){ err.textContent='Invalid username or PIN.'; return; }
      err.textContent=''; setUser({ username: u.username, role: u.role });
      window.location.href='dashboard.html';
    });
  })();

  // ---------- DASHBOARD ----------
  (function initDashboard(){
    const startBtn = document.getElementById('submitLog');
    if (!startBtn) return;

    const user = getUser();
    if (!user) { window.location.href='index.html'; return; }

    const liveBtn = document.getElementById('liveViewBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const deleteAllBtn = document.getElementById('deleteAllLogs');

    const isAdmin = String(user.role||'').toLowerCase()==='admin';
    if (!isAdmin) { liveBtn && (liveBtn.style.display='none'); deleteAllBtn && (deleteAllBtn.style.display='none'); }

    liveBtn?.addEventListener('click', ()=> window.location.href='admin.html');
    logoutBtn?.addEventListener('click', ()=> { clearUser(); window.location.href='index.html'; });

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
      } else {
        expTime.textContent='--'; expNotes.textContent='--'; expLoc.textContent='--'; expSA.textContent='--';
      }
    }
    partSelect.addEventListener('change', ()=> fillInfoFromPart(partSelect.value));

    startBtn.addEventListener('click', async ()=>{
      const pn = partSelect.value;
      if (!pn){ alert('Please select a part.'); return; }
      try{
        await jobsApi(`/log`, { method:'POST', body: JSON.stringify({
          username: user.username, partNumber: pn, action:'Start', startTime: Date.now()
        })});
        partSelect.value=''; fillInfoFromPart('');
        await requestRefresh(true);
      }catch(err){ console.error(err); alert('Failed to start job.'); }
    });

    const draftKey = (id)=> `draftNotes:${user.username}:${id}`;
    const getDraft = (id)=> localStorage.getItem(draftKey(id)) || '';
    const setDraft = (id,val)=> localStorage.setItem(draftKey(id), val);
    const clearDraft = (id)=> localStorage.removeItem(draftKey(id));

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
    const endInteraction = ()=> { const inside=tBody.contains(document.activeElement); if (!inside) isInteracting = false; };
    tBody.addEventListener('focusin', beginInteraction);
    tBody.addEventListener('focusout', () => setTimeout(endInteraction, 0));
    tBody.addEventListener('mousedown', (e)=>{
      const tr = e.target.closest('tr'); if (!tr) return;
      const id = tr.dataset.id;
      const pn = tr.querySelector('td')?.textContent.trim() || '';
      selectRow(tr, { id, partNumber: pn });
    }, true);

    let lastSig = '';
    function makeSignature(rows){
      const minimal = rows.filter(r=>!r.endTime).map(r=>({
        id:r.id, partNumber:r.partNumber, action:r.action, startTime:r.startTime, endTime:r.endTime, pauseStart:r.pauseStart, pauseTotal:r.pauseTotal
      }));
      return JSON.stringify(minimal);
    }

    // HARD-FREEZE mechanism: when paused, stop updating the cell completely
    function freezeCell(td){
      if (!td) return;
      td.setAttribute('data-frozen', '1');
      td.setAttribute('data-frozen-text', td.textContent);
    }
    function unfreezeCell(td){
      if (!td) return;
      td.removeAttribute('data-frozen');
      td.removeAttribute('data-frozen-text');
    }

    // Local timing tweak for instant UX, paired with freeze
    function applyLocalTiming(tr, act){
      const td = tr.querySelector('.dur');
      if (!td) return { revert: ()=>{} };

      const snapshot = {
        pause: td.getAttribute('data-pause') || '',
        paused: td.getAttribute('data-paused') || '0',
        text: td.textContent,
        frozen: td.getAttribute('data-frozen') || ''
      };
      const start = Number(td.getAttribute('data-start')) || 0;
      const now = Date.now();

      if (act === 'Pause') {
        // set pause start and FREEZE display
        td.setAttribute('data-pause', String(now));
        td.textContent = fmtDuration(start, now, 0, Number(td.getAttribute('data-paused')) || 0);
        freezeCell(td);
      } else if (act === 'Continue') {
        // fold paused delta into total and UNFREEZE
        const pStart = Number(td.getAttribute('data-pause')) || 0;
        if (pStart) {
          const delta = Math.max(0, now - pStart);
          const newTotal = (Number(td.getAttribute('data-paused')) || 0) + delta;
          td.setAttribute('data-paused', String(newTotal));
          td.setAttribute('data-pause', '');
          unfreezeCell(td);
          td.textContent = fmtDuration(start, null, 0, newTotal);
        } else {
          unfreezeCell(td);
        }
      }

      return {
        revert: ()=> {
          td.setAttribute('data-pause', snapshot.pause);
          td.setAttribute('data-paused', snapshot.paused);
          td.textContent = snapshot.text;
          if (snapshot.frozen) td.setAttribute('data-frozen', snapshot.frozen);
          else unfreezeCell(td);
        }
      };
    }

    // Action buttons
    tBody.addEventListener('click', async (e)=>{
      const btn = e.target.closest('button[data-act]'); if (!btn) return;
      const tr = btn.closest('tr'); if (!tr) return;
      const logId = Number(tr.dataset.id);
      const act = btn.getAttribute('data-act');

      const group = tr.querySelectorAll('button[data-act]');
      group.forEach(b=> b.disabled = true);

      // instant local UX (with freeze)
      const local = applyLocalTiming(tr, act);

      try{
        const body = { action: act };
        if (act === 'Finish'){
          body.endTime = Date.now();
          const latestDraft = tr.querySelector('textarea.notes-box')?.value.trim();
          if (latestDraft) body.note = latestDraft;
        }
        await jobsApi(`/log/${logId}`, { method:'PUT', body: JSON.stringify(body) });

        // enable states
        const pauseBtn = tr.querySelector('button[data-act="Pause"]');
        const contBtn  = tr.querySelector('button[data-act="Continue"]');
        if (act === 'Pause'){ pauseBtn && (pauseBtn.disabled = true); contBtn && (contBtn.disabled = false); }
        else if (act === 'Continue'){ contBtn && (contBtn.disabled = true); pauseBtn && (pauseBtn.disabled = false); }

        if (act === 'Finish'){
          clearDraft(logId);
          if (selectedLogId === logId){ selectedLogId = null; fillInfoFromPart(''); }
          await requestRefresh(true);
        } else {
          // force re-render soon to sync with server values
          lastSig = '';
        }
      }catch(err){
        console.error(err);
        local.revert(); // put UI back if server said no
        alert('Failed to update action.');
      }finally{
        group.forEach(b=> b.disabled = false);
      }
    });

    async function refreshActive(force=false){
      if (isInteracting && !force) return;
      const rows = await jobsApi(`/logs/${encodeURIComponent(user.username)}`, { method:'GET' });
      const active = rows.filter(r=>!r.endTime);
      const sig = makeSignature(rows);
      if (!force && sig === lastSig) return; lastSig = sig;

      const prevScroll = tBody.parentElement?.scrollTop ?? 0;
      tBody.innerHTML='';
      active.forEach(log=>{
        const tr=document.createElement('tr'); tr.dataset.id=log.id;
        const draft=getDraft(log.id)||log.note||'';
        const current=(log.action||'').trim(); const logical=(current==='Pause'||current==='Finish')?current:'Continue';
        const pausedNow = !!log.pauseStart;
        tr.innerHTML=`
          <td>${log.partNumber||''}</td>
          <td><textarea class="notes-box" data-id="${log.id}" placeholder="Type notes...">${draft}</textarea></td>
          <td class="actions-cell">
            <div class="btn-group">
              <button class="btn3d small pause" data-act="Pause" ${logical==='Pause'?'disabled':''}>Pause</button>
              <button class="btn3d small continue" data-act="Continue" ${logical==='Continue'?'disabled':''}>Continue</button>
              <button class="btn3d small finish" data-act="Finish">Finish</button>
            </div>
          </td>
          <td>${log.startTime ? new Date(log.startTime).toLocaleString() : ''}</td>
          <td class="dur"
              data-start="${log.startTime || ''}"
              data-pause="${log.pauseStart || ''}"
              data-paused="${log.pauseTotal || 0}">
            ${fmtDuration(log.startTime, pausedNow ? log.pauseStart : null, pausedNow ? 0 : log.pauseStart, log.pauseTotal)}
          </td>
        `;
        // If server says it's paused, freeze the display exactly at pauseStart
        const td = tr.querySelector('.dur');
        if (pausedNow){
          freezeCell(td);
        }
        tr.querySelector('textarea.notes-box').addEventListener('input', e=> setDraft(log.id, e.target.value));
        tBody.appendChild(tr);
      });

      if (selectedLogId && active.some(r=> r.id===selectedLogId)){ highlightById(selectedLogId); const log=active.find(r=> r.id===selectedLogId); fillInfoFromPart(log?.partNumber||''); }
      else if (selectedLogId){ selectedLogId=null; fillInfoFromPart(''); }

      if (tBody.parentElement) tBody.parentElement.scrollTop = prevScroll;
    }
    async function requestRefresh(force=false){ await refreshActive(force); }
    function tickDurations(){
      tBody.querySelectorAll('.dur').forEach(td=>{
        if (td.getAttribute('data-frozen') === '1') {
          // keep the frozen text; do nothing
          td.textContent = td.getAttribute('data-frozen-text') || td.textContent;
          return;
        }
        const s=Number(td.getAttribute('data-start'))||0;
        const pS=Number(td.getAttribute('data-pause'))||0;
        const pT=Number(td.getAttribute('data-paused'))||0;
        td.textContent=fmtDuration(s,null,pS,pT);
      });
    }

    deleteAllBtn?.addEventListener('click', async ()=>{
      if (!confirm('Delete ALL your logs?')) return;
      try{ await jobsApi(`/delete-logs/${encodeURIComponent(user.username)}`, { method:'DELETE' }); tBody.innerHTML=''; }
      catch(err){ console.error(err); alert('Failed to delete logs.'); }
    });

    requestRefresh(true).catch(console.error);
    setInterval(()=> requestRefresh(false), 5000);
    setInterval(tickDurations, 1000);
  })();
});
