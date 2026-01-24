// script.js — login + dashboard; part number is the ONLY selector for details; hard-freeze Pause
document.addEventListener('DOMContentLoaded', () => {
  const API_ROOT = 'https://wireshop-backend.onrender.com';
  const API_JOBS = `${API_ROOT}/api/jobs`;

  // --- FORCE /inventory to the real file /inventory.html ---
  (function redirectInventoryRoute(){
    const p = (location.pathname || '').toLowerCase();
    if (p === '/inventory') {
      location.replace('/inventory.html');
    }
  })();

  // If someone lands on the old dashboard page, shove them to Build Next.
  (function redirectDashboard(){
    const p = (location.pathname || '').toLowerCase();
    if (p.endsWith('/dashboard.html') || p === '/dashboard') {
      location.replace('/assignments.html');
    }
  })();

  // Clean the top nav: only keep Assignments, Inventory, Admin (admins only), Logout.
  (function tidyTopNav(){
    let user = null;
    try { user = JSON.parse(localStorage.getItem('user') || 'null'); } catch {}
    const role = String(user?.role || 'tech').toLowerCase();
    const isAdmin = role === 'admin';

    const bars = document.querySelectorAll('.brand-actions');
    if (!bars.length) return;

    bars.forEach(bar => {
      // Remove unwanted links if they exist
      bar.querySelectorAll('a').forEach(a => {
        const href = String(a.getAttribute('href') || '').toLowerCase();
        if (href.includes('dashboard') || href.includes('archive')) a.remove();
      });

      // Ensure Inventory link points to inventory.html (NOT /inventory)
      const invLink = [...bar.querySelectorAll('a')].find(a => {
        const href = String(a.getAttribute('href') || '').toLowerCase();
        return href === '/inventory' || href.endsWith('/inventory');
      });
      if (invLink) invLink.setAttribute('href', '/inventory.html');

      // Ensure Admin link exists but only visible for admins
      let adminLink = [...bar.querySelectorAll('a')].find(a => (a.getAttribute('href') || '').toLowerCase().includes('admin'));
      if (!adminLink) {
        adminLink = document.createElement('a');
        adminLink.className = 'navbtn';
        adminLink.href = '/admin.html';
        adminLink.textContent = 'Admin';
        bar.insertBefore(adminLink, bar.querySelector('#logoutBtn') || bar.lastElementChild);
      }
      adminLink.style.display = isAdmin ? '' : 'none';
    });
  })();

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

  // Styles: 3D buttons + clickable part-number link
  (function injectStyles(){
    const css = `
      .btn3d{appearance:none;border:1px solid transparent;border-radius:12px;padding:7px 12px;font-weight:700;cursor:pointer;letter-spacing:.2px;
        box-shadow:0 3px 0 rgba(0,0,0,.28),0 10px 18px rgba(0,0,0,.10);transition:transform .06s, box-shadow .06s, filter .15s, opacity .15s;text-shadow:0 1px 0 rgba(255,255,255,.35);}
      .btn3d.small{font-size:.9rem;line-height:1}
      .btn3d:active{transform:translateY(1px);box-shadow:0 1px 0 rgba(0,0,0,.28),0 6px 12px rgba(0,0,0,.14)}
      .btn3d.pause{color:#4a2a00;background:linear-gradient(#ffd99a,#ffb44a);border-color:#e0902d}
      .btn3d.continue{color:#0f4a2d;background:linear-gradient(#bff3d3,#4fd08a);border-color:#2fb26f}
      .btn3d.finish{color:#5a0e12;background:linear-gradient(#ffc5c5,#ff6e6e);border-color:#e24a4a}
      .btn3d[disabled]{opacity:.55;cursor:not-allowed;box-shadow:0 2px 0 rgba(0,0,0,.12),0 4px 8px rgba(0,0,0,.06)}
      .btn-group{display:flex;gap:.5rem;align-items:center}
      .actions-cell{min-width:240px}
      .notes-box{min-width:240px}
      .row-selected{outline:2px solid #0072ff33}
      .part-link{background:none;border:none;padding:0;margin:0;color:#0b61ff;cursor:pointer;font-weight:700;text-decoration:underline}
      .part-link:focus{outline:2px solid #0072ff33;border-radius:4px}
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

      // Try backend users only (NO users.js fallback)
      try{
        const res = await fetch(`${API_ROOT}/api/auth/login`, {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ username: uname, pin })
        });

        if (res.ok){
          const data = await res.json();
          setUser({ username: data.username, role: data.role });

          const _p = new URLSearchParams(location.search);
          const _r = _p.get('redirect');
          window.location.href = _r ? _r : 'assignments.html';
          return;
        }
      }catch(ex){
        console.error('Login error:', ex);
      }

      err.textContent = "Invalid username or PIN.";
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
        td.setAttribute('data-pause', String(now));
        td.textContent = fmtDuration(start, now, 0, Number(td.getAttribute('data-paused')) || 0);
        freezeCell(td);
      } else if (act === 'Continue') {
        const pStart = Number(td.getAttribute('data-pause')) || 0;
        if (pStart) {
          const delta = Math.max(0, now - pStart);
          const newTotal = (Number(td.getAttribute('data-paused')) || 0) + delta;
          td.setAttribute('data-paused', String(newTotal));
          td.setAttribute('data-pause', '');
          unfreezeCell(td);
        }
      } else if (act === 'Finish') {
        const pStart = Number(td.getAttribute('data-pause')) || 0;
        let pausedTotal = Number(td.getAttribute('data-paused')) || 0;
        if (pStart) pausedTotal += Math.max(0, now - pStart);
        td.textContent = fmtDuration(start, now, 0, pausedTotal);
        freezeCell(td);
      }

      return {
        revert: ()=>{
          td.setAttribute('data-pause', snapshot.pause);
          td.setAttribute('data-paused', snapshot.paused);
          td.textContent = snapshot.text;
          if (snapshot.frozen) freezeCell(td); else unfreezeCell(td);
        }
      };
    }

    function renderRows(rows){
      const active = rows.filter(r => r.username === user.username && !r.endTime);
      const others = rows.filter(r => !(r.username === user.username && !r.endTime));

      // Track if selected id still exists
      const allIds = new Set(rows.map(r => String(r.id)));
      if (selectedLogId && !allIds.has(String(selectedLogId))) selectedLogId = null;

      // Keep current freeze text if paused and frozen
      const existingFreeze = {};
      tBody.querySelectorAll('tr').forEach(tr=>{
        const id = tr.dataset.id;
        const td = tr.querySelector('.dur');
        if (id && td && td.getAttribute('data-frozen')==='1') {
          existingFreeze[id] = td.getAttribute('data-frozen-text') || td.textContent;
        }
      });

      const mkRow = (r)=>{
        const rec = (window.catalog || []).find(p => p.partNumber === r.partNumber) || {};
        const canPause = r.action !== 'Pause';
        const canContinue = r.action === 'Pause';
        const canFinish = true;

        const tr = document.createElement('tr');
        tr.dataset.id = String(r.id);

        // duration text with freeze restore if needed
        let durText = fmtDuration(r.startTime, r.endTime, r.pauseStart, r.pauseTotal);
        if (existingFreeze[tr.dataset.id]) durText = existingFreeze[tr.dataset.id];

        tr.innerHTML = `
          <td class="pn"><button class="part-link" data-pn="${r.partNumber}" title="Select this row">${r.partNumber}</button></td>
          <td>${rec.printName || ''}</td>
          <td>${r.action || ''}</td>
          <td class="notes-box">
            <input class="noteIn" placeholder="notes..." value="${(getDraft(r.id) || r.note || '').replace(/"/g,'&quot;')}" />
          </td>
          <td class="dur" data-start="${r.startTime||''}" data-pause="${r.pauseStart||''}" data-paused="${r.pauseTotal||0}">${durText}</td>
          <td class="actions-cell">
            <div class="btn-group">
              <button class="btn3d small pause" data-act="Pause" ${canPause?'':'disabled'}>Pause</button>
              <button class="btn3d small continue" data-act="Continue" ${canContinue?'':'disabled'}>Continue</button>
              <button class="btn3d small finish" data-act="Finish" ${canFinish?'':'disabled'}>Finish</button>
            </div>
          </td>
        `;

        const tdDur = tr.querySelector('.dur');
        if (r.action === 'Pause' || r.endTime) freezeCell(tdDur);
        else unfreezeCell(tdDur);

        // Only part number selects row
        tr.querySelector('.part-link').addEventListener('click', ()=>{
          selectRow(tr, r);
        });

        // Notes draft persistence
        const noteIn = tr.querySelector('.noteIn');
        noteIn.addEventListener('input', ()=> setDraft(r.id, noteIn.value));

        // Action buttons
        tr.querySelectorAll('button[data-act]').forEach(btn=>{
          btn.addEventListener('click', async ()=>{
            const act = btn.dataset.act;
            const note = (noteIn.value || '').trim();

            const local = applyLocalTiming(tr, act);

            try{
              await jobsApi(`/log/${r.id}`, {
                method:'PUT',
                body: JSON.stringify({ action: act, note })
              });
              clearDraft(r.id);
              await requestRefresh(true);
            }catch(err){
              console.error(err);
              local.revert();
              alert(`Failed to ${act}.`);
            }
          });
        });

        return tr;
      };

      tBody.innerHTML = '';
      [...active, ...others].forEach(r => tBody.appendChild(mkRow(r)));

      if (selectedLogId) highlightById(String(selectedLogId));
    }

    async function requestRefresh(force){
      if (isInteracting && !force) return;
      try{
        const rows = await jobsApi(`/list`);
        const sig = makeSignature(rows);
        if (sig !== lastSig || force){
          lastSig = sig;
          renderRows(rows);
        }
      }catch(err){
        console.error(err);
      }
    }

    // periodic update for running timers, but respect freeze
    setInterval(()=>{
      tBody.querySelectorAll('.dur').forEach(td=>{
        if (td.getAttribute('data-frozen')==='1') {
          const frozenText = td.getAttribute('data-frozen-text');
          if (frozenText) td.textContent = frozenText;
          return;
        }
        const start = Number(td.getAttribute('data-start'))||0;
        const pStart = Number(td.getAttribute('data-pause'))||0;
        const pTotal = Number(td.getAttribute('data-paused'))||0;
        td.textContent = fmtDuration(start, 0, pStart, pTotal);
      });
    }, 1000);

    requestRefresh(true);
    setInterval(()=> requestRefresh(false), 5000);
  })();

  // ---------- ARCHIVE PAGE ----------
  (function initArchive(){
    const tableBody = document.getElementById('archiveTableBody');
    if (!tableBody) return;

    const user = getUser();
    if (!user) { window.location.href='index.html'; return; }

    // Gate admin-only view
    if (String(user.role||'').toLowerCase() !== 'admin'){
      window.location.href='assignments.html';
      return;
    }

    async function archiveApi(path, options={}){
      const headers = { 'Content-Type': 'application/json', 'x-user': username() };
      const res = await fetch(`${API_ROOT}/api/archive${path}`, { headers, ...options });
      if (!res.ok) throw new Error(await res.text().catch(()=> 'archive error'));
      const ct = res.headers.get('content-type') || '';
      return ct.includes('application/json') ? res.json() : res.text();
    }

    const fTech = document.getElementById('fTech');
    const fPart = document.getElementById('fPart');
    const fFrom = document.getElementById('fFrom');
    const fTo = document.getElementById('fTo');
    const btnApply = document.getElementById('btnApply');
    const btnReset = document.getElementById('btnReset');
    const btnExport = document.getElementById('btnExport');
    const countEl = document.getElementById('archiveCount');

    async function loadTechs(){
      try{
        const res = await fetch(`${API_ROOT}/api/users`, { headers:{'Content-Type':'application/json','x-user': username()} });
        if (!res.ok) return;
        const users = await res.json();
        (users||[]).forEach(u=>{
          const opt=document.createElement('option');
          opt.value=u.username; opt.textContent=u.username;
          fTech.appendChild(opt);
        });
      }catch{}
    }

    function qp(){
      const p = new URLSearchParams();
      if (fTech.value && fTech.value !== 'All') p.set('tech', fTech.value);
      if (fPart.value.trim()) p.set('partContains', fPart.value.trim());
      if (fFrom.value) p.set('from', fFrom.value);
      if (fTo.value) p.set('to', fTo.value);
      return p.toString();
    }

    async function load(){
      try{
        const rows = await archiveApi(`?${qp()}`);
        countEl && (countEl.textContent = `${rows.length} records`);
        tableBody.innerHTML = '';
        if (!rows.length){
          tableBody.innerHTML = `<tr><td colspan="8" style="opacity:.7;">0 records</td></tr>`;
          return;
        }
        rows.forEach(r=>{
          const tr=document.createElement('tr');
          tr.innerHTML = `
            <td>${new Date(r.finishedAt||0).toLocaleString()}</td>
            <td>${r.username||''}</td>
            <td>${r.partNumber||''}</td>
            <td>${r.printName||''}</td>
            <td>${(r.expectedHours!=null)?r.expectedHours:''}</td>
            <td>${r.note||''}</td>
            <td>${fmtDuration(r.startTime, r.endTime, 0, r.pauseTotal||0)}</td>
            <td></td>
          `;
          tableBody.appendChild(tr);
        });
      }catch(err){
        console.error(err);
        tableBody.innerHTML = `<tr><td colspan="8" style="opacity:.7;">Archive load failed</td></tr>`;
      }
    }

    btnApply?.addEventListener('click', load);
    btnReset?.addEventListener('click', ()=>{
      fTech.value='All'; fPart.value=''; fFrom.value=''; fTo.value='';
      load();
    });

    btnExport?.addEventListener('click', async ()=>{
      try{
        const res = await fetch(`${API_ROOT}/api/archive/export`, { headers:{'Content-Type':'application/json','x-user': username()} });
        if (!res.ok) return alert('Export endpoint not available');
        const blob = await res.blob();
        const a=document.createElement('a');
        a.href=URL.createObjectURL(blob);
        a.download='archive.csv';
        a.click();
      }catch{ alert('Export failed'); }
    });

    loadTechs().then(load);
  })();

  // ---------- ADMIN PAGE ----------
  (function initAdmin(){
    const usersBody = document.getElementById('usersBody');
    const liveBody = document.getElementById('liveBody');
    const archiveBody = document.getElementById('archiveBody');
    const clearAllBtn = document.getElementById('clearAllLogs');
    const addBtn = document.getElementById('btnAddUser');
    if (!usersBody && !liveBody && !archiveBody && !clearAllBtn && !addBtn) return;

    const user = getUser();
    if (!user) { window.location.href='index.html'; return; }
    if (String(user.role||'').toLowerCase() !== 'admin'){ window.location.href='assignments.html'; return; }

    // NOTE: your admin.html now has its own embedded JS, so this block does nothing unless you still have old admin.html.
  })();

});
