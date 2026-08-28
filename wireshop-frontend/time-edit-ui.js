// Admin-only timer corrections for Build Next + Build History.
(() => {
  if (window.__adminTimeEditLoaded) return;
  window.__adminTimeEditLoaded = true;

  const user = (() => { try { return JSON.parse(localStorage.getItem('user') || '{}'); } catch { return {}; } })();
  if (!user.username || String(user.role || '').toLowerCase() !== 'admin') return;

  const API = (localStorage.getItem('API_BASE') || 'https://wireshop-backend.onrender.com').replace(/\/+$/, '');
  const nativeFetch = window.fetch.bind(window);
  let doneEvents = [];
  let historyEvents = [];
  let queued = false;

  // Capture the completion feeds the existing pages already request.
  window.fetch = async (...args) => {
    const res = await nativeFetch(...args);
    try {
      const input = args[0];
      const url = typeof input === 'string' ? input : (input?.url || '');
      if (url.includes('/api/build-task-events') && /(?:\?|&)type=complete(?:&|$)/.test(url)) {
        const all = /(?:\?|&)includeHidden=1(?:&|$)/.test(url);
        res.clone().json().then(rows => {
          if (Array.isArray(rows)) {
            if (all) historyEvents = rows;
            else doneEvents = rows;
            schedule();
          }
        }).catch(() => {});
      }
    } catch (_) {}
    return res;
  };

  const hdr = () => ({ 'Content-Type':'application/json', 'x-user':user.username, 'x-role':user.role || '' });
  async function patch(path, body) {
    const res = await nativeFetch(API + path, { method:'PATCH', headers:hdr(), body:JSON.stringify(body) });
    if (!res.ok) {
      let msg = res.statusText || 'Request failed';
      try { const j = await res.json(); msg = j.error || j.detail || msg; } catch (_) {}
      throw new Error(msg);
    }
    return res.json();
  }

  function fmt(v) {
    let s = Math.max(0, Math.round(Number(v || 0)));
    const h = Math.floor(s / 3600); s %= 3600;
    const m = Math.floor(s / 60), sec = s % 60;
    return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  }

  function parse(v) {
    const s = String(v ?? '').trim();
    if (/^\d+(?:\.\d+)?$/.test(s)) return Math.round(Number(s) * 3600);
    const p = s.split(':');
    if ((p.length !== 2 && p.length !== 3) || !p.every(x => /^\d+$/.test(x))) return null;
    const h = Number(p[0]), m = Number(p[1]), sec = p.length === 3 ? Number(p[2]) : 0;
    if (m > 59 || sec > 59) return null;
    return h * 3600 + m * 60 + sec;
  }

  function ask(label, current) {
    const v = prompt(`Correct TOTAL WORKED TIME for ${label}\n\nUse H:MM:SS (4:30:00) or decimal hours (4.5).`, fmt(current));
    if (v === null) return null;
    const s = parse(v);
    if (s === null) alert('Invalid time. Use H:MM:SS, H:MM, or decimal hours.');
    return s;
  }

  const text = el => String(el?.textContent || '').replace(/\s+/g, ' ').trim();
  function style() {
    if (document.getElementById('timeEditStyle')) return;
    const s = document.createElement('style');
    s.id = 'timeEditStyle';
    s.textContent = '.timeEdit{margin:4px 0 0 6px;padding:3px 7px;border:1px solid #777;border-radius:6px;background:#f2f2f2;color:#111;font-weight:800;font-size:11px;cursor:pointer;white-space:nowrap}.timeEdit:hover{background:#fff}.timeEdit:disabled{opacity:.55}.timeWrap{display:inline-flex;align-items:center;gap:5px}';
    document.head.appendChild(s);
  }

  function active() {
    document.querySelectorAll('#claimedActiveBody tr,#claimedPausedBody tr,#claimedWaitingBody tr').forEach(tr => {
      const timer = tr.querySelector('.timerVal');
      if (!timer || !tr.dataset.id || tr.querySelector('.timeEditActive')) return;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'timeEdit timeEditActive'; b.textContent = 'Edit Time'; b.dataset.id = tr.dataset.id;
      timer.closest('td')?.appendChild(b);
    });
  }

  function wrap(cell, ev, cls) {
    if (!cell || cell.querySelector('.timeEditDone')) return;
    const sec = Math.max(0, Number(ev.elapsedSeconds || 0));
    const w = document.createElement('span'); w.className = 'timeWrap';
    const v = document.createElement('span'); v.className = 'timeValue'; v.textContent = sec > 0 ? fmt(sec) : '—';
    const b = document.createElement('button');
    b.type='button'; b.className=`timeEdit timeEditDone ${cls}`; b.textContent='Edit Time'; b.dataset.id=String(ev.id); b.dataset.sec=String(sec);
    w.append(v,b); cell.textContent=''; cell.appendChild(w);
  }

  function recent() {
    const body = document.getElementById('doneBody');
    if (!body || !doneEvents.length) return;
    const ev = doneEvents.filter(x => Number.isFinite(Number(x.ts))).slice().sort((a,b)=>b.ts-a.ts).slice(0,200);
    [...body.querySelectorAll('tr')].forEach((tr,i) => {
      if (tr.cells?.length >= 6 && ev[i]) wrap(tr.cells[4], ev[i], 'timeEditRecent');
    });
  }

  function hDate(e) {
    const d = new Date(Number(e.ts || 0));
    if (Number.isNaN(d.getTime())) return '—';
    return String(e.reason || '').startsWith('history_import') ? d.toLocaleDateString() : d.toLocaleString();
  }
  function eKey(e) {
    const sec = Math.max(0, Number(e.elapsedSeconds || 0));
    return [hDate(e), String(e.user || e.claimedBy || '').trim(), String(e.partNumber || '').trim(), String(Math.max(1,Math.trunc(Number(e.qty)||1))), sec > 0 ? fmt(sec) : '—'].join('|');
  }
  function rKey(tr) { return [text(tr.cells[0]),text(tr.cells[1]),text(tr.cells[2]),text(tr.cells[4]),text(tr.cells[5])].join('|'); }

  function history() {
    const body = document.getElementById('detailBody');
    if (!body || !historyEvents.length) return;
    const map = new Map();
    historyEvents.forEach(e => { const k=eKey(e); if(!map.has(k)) map.set(k,[]); map.get(k).push(e); });
    [...body.querySelectorAll('tr')].forEach(tr => {
      if (tr.cells?.length < 7 || tr.querySelector('.timeEditDone')) return;
      const list = map.get(rKey(tr));
      if (list?.length) wrap(tr.cells[5], list.shift(), 'timeEditHistory');
    });
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued=false; active(); recent(); history(); });
  }

  document.addEventListener('click', async e => {
    const a = e.target.closest?.('.timeEditActive');
    const d = e.target.closest?.('.timeEditDone');
    if (!a && !d) return;
    e.preventDefault(); e.stopPropagation();

    if (a) {
      const tr = a.closest('tr'), timer = tr?.querySelector('.timerVal');
      const current = parse(text(timer)) ?? Number(timer?.dataset.base || 0);
      const sec = ask(`${text(tr?.cells?.[0])} — ${text(tr?.cells?.[3])}`, current);
      if (sec === null) return;
      a.disabled = true;
      try {
        const r = await patch(`/api/build-tasks/${a.dataset.id}/admin-time`, { elapsedSeconds:sec });
        const corrected = Math.max(0, Number(r.elapsedSeconds ?? sec));
        timer.textContent=fmt(corrected); timer.dataset.base=String(corrected); timer.dataset.rendered=String(Date.now());
        a.textContent='Saved'; setTimeout(()=>{ if(a.isConnected){a.textContent='Edit Time';a.disabled=false;} },800);
      } catch (err) { a.disabled=false; alert(`Time correction failed: ${err.message}`); }
      return;
    }

    const tr = d.closest('tr');
    const inHistory = !!tr?.closest('#detailBody');
    const sec = ask(`${text(tr?.cells?.[inHistory?2:0])} — ${text(tr?.cells?.[inHistory?1:3])}`, Number(d.dataset.sec || 0));
    if (sec === null) return;
    d.disabled = true;
    try {
      const r = await patch(`/api/build-history/${d.dataset.id}/admin-time`, { elapsedSeconds:sec });
      const corrected = Math.max(0, Number(r.elapsedSeconds ?? sec));
      d.dataset.sec=String(corrected); d.closest('.timeWrap')?.querySelector('.timeValue')?.replaceChildren(corrected > 0 ? fmt(corrected) : '—');
      [doneEvents,historyEvents].forEach(list => { const x=list.find(v=>Number(v.id)===Number(d.dataset.id)); if(x) x.elapsedSeconds=corrected; });
      d.textContent='Saved';
      if (inHistory) setTimeout(()=>document.getElementById('refreshBtn')?.click(),120);
      else setTimeout(()=>{ if(d.isConnected){d.textContent='Edit Time';d.disabled=false;} },800);
    } catch (err) { d.disabled=false; alert(`Time correction failed: ${err.message}`); }
  }, true);

  function init() {
    style();
    new MutationObserver(schedule).observe(document.body,{childList:true,subtree:true});
    schedule();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init,{once:true}); else init();
})();
