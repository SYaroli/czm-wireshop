// Role-aware row action menus for Build Next + Build History.
// Keeps primary actions visible, moves secondary actions into right-click / ⋮ menus.
(() => {
  if (window.__rowContextActionsLoaded) return;
  window.__rowContextActionsLoaded = true;

  const path = String(location.pathname || '').toLowerCase();
  const onAssignments = path.endsWith('/assignments.html') || path === '/assignments';
  const onHistory = path.endsWith('/build-history.html') || path === '/build-history';
  if (!onAssignments && !onHistory) return;

  let menu = null;
  let scheduled = false;

  function injectStyle() {
    if (document.getElementById('rowContextActionsStyle')) return;
    const s = document.createElement('style');
    s.id = 'rowContextActionsStyle';
    s.textContent = `
      .row-menu-trigger{
        appearance:none;border:1px solid #c8ced8;border-radius:8px;background:#fff;color:#222;
        min-width:34px;width:34px;height:34px;padding:0;font-size:22px;font-weight:900;line-height:28px;
        cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.08);vertical-align:middle;
      }
      .row-menu-trigger:hover{background:#f2f4f7;border-color:#9fa8b6}
      .row-menu-trigger:active{transform:translateY(1px)}
      .context-actions-cell{white-space:nowrap;text-align:right}
      .row-context-menu{
        position:fixed;z-index:100000;min-width:190px;max-width:280px;padding:6px;
        background:#fff;border:1px solid #c7ccd4;border-radius:10px;
        box-shadow:0 12px 30px rgba(0,0,0,.22);font-family:inherit;
      }
      .row-context-title{padding:6px 9px 7px;font-size:11px;font-weight:900;color:#68707c;border-bottom:1px solid #e5e8ed;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .row-context-menu button{
        appearance:none;width:100%;border:0;border-radius:7px;background:transparent;color:#17191c;
        padding:9px 10px;text-align:left;font:inherit;font-weight:750;cursor:pointer;
      }
      .row-context-menu button:hover,.row-context-menu button:focus{background:#eef1f5;outline:none}
      .row-context-menu button.danger{color:#a00000}
      .row-context-menu button.danger:hover,.row-context-menu button.danger:focus{background:#fff0f0}
      .row-context-menu button[disabled]{opacity:.45;cursor:not-allowed}

      /* Secondary controls are still in the DOM so the existing click handlers remain the source of truth. */
      #queuedBody button[data-cancel],
      #claimedActiveBody button[data-starttimer], #claimedPausedBody button[data-starttimer], #claimedWaitingBody button[data-starttimer],
      #claimedActiveBody button[data-pause], #claimedPausedBody button[data-pause], #claimedWaitingBody button[data-pause],
      #claimedActiveBody button[data-resume], #claimedPausedBody button[data-resume], #claimedWaitingBody button[data-resume],
      #claimedActiveBody button[data-waiting], #claimedPausedBody button[data-waiting], #claimedWaitingBody button[data-waiting],
      #claimedActiveBody button[data-unclaim], #claimedPausedBody button[data-unclaim], #claimedWaitingBody button[data-unclaim],
      #claimedActiveBody .timeEdit, #claimedPausedBody .timeEdit, #claimedWaitingBody .timeEdit,
      #doneBody .timeEdit, #detailBody .timeEdit{
        display:none !important;
      }
    `;
    document.head.appendChild(s);
  }

  function closeMenu() {
    if (menu) menu.remove();
    menu = null;
  }

  function labelFor(btn) {
    if (btn.dataset.claim) return 'Start';
    if (btn.dataset.cancel) return 'Cancel';
    if (btn.dataset.starttimer) return 'Start Timer';
    if (btn.dataset.pause) return 'Pause';
    if (btn.dataset.resume) return 'Resume';
    if (btn.dataset.waiting) return 'Waiting';
    if (btn.dataset.complete) return 'Complete';
    if (btn.dataset.unclaim) return 'Unclaim';
    if (btn.dataset.savewaitnote) return 'Save Note';
    if (btn.classList.contains('timeEdit')) return 'Edit Time';
    return String(btn.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isActionButton(btn) {
    if (!btn || btn.classList.contains('row-menu-trigger')) return false;
    return !!(
      btn.dataset.claim || btn.dataset.cancel || btn.dataset.starttimer || btn.dataset.pause ||
      btn.dataset.resume || btn.dataset.waiting || btn.dataset.complete || btn.dataset.unclaim ||
      btn.dataset.savewaitnote || btn.classList.contains('timeEdit')
    );
  }

  function relatedRows(tr) {
    const id = String(tr?.dataset?.id || '');
    if (!id || !tr.closest('#claimedActiveBody,#claimedPausedBody,#claimedWaitingBody')) return [tr];
    const rows = [];
    document.querySelectorAll('#claimedActiveBody tr,#claimedPausedBody tr,#claimedWaitingBody tr').forEach(r => {
      if (String(r.dataset.id || '') === id) rows.push(r);
    });
    return rows.length ? rows : [tr];
  }

  function actionsFor(tr) {
    const seen = new Set();
    const out = [];
    relatedRows(tr).forEach(r => {
      r.querySelectorAll('button').forEach(btn => {
        if (!isActionButton(btn)) return;
        const label = labelFor(btn);
        if (!label) return;
        const id = btn.dataset.id || btn.dataset.claim || btn.dataset.cancel || btn.dataset.starttimer || btn.dataset.pause || btn.dataset.resume || btn.dataset.waiting || btn.dataset.complete || btn.dataset.unclaim || btn.dataset.savewaitnote || '';
        const key = `${label}|${id}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
          label,
          source: btn,
          danger: !!btn.dataset.cancel,
          disabled: !!btn.disabled
        });
      });
    });
    return out;
  }

  function rowTitle(tr) {
    if (!tr?.cells?.length) return 'Actions';
    if (tr.closest('#detailBody')) {
      const part = String(tr.cells[2]?.textContent || '').trim();
      const tech = String(tr.cells[1]?.textContent || '').trim();
      return [part, tech].filter(Boolean).join(' — ') || 'Actions';
    }
    const part = String(tr.cells[0]?.textContent || '').replace(/\s+/g, ' ').trim();
    const techCell = tr.closest('#claimedActiveBody,#claimedPausedBody,#claimedWaitingBody') ? 3 : -1;
    const tech = techCell >= 0 ? String(tr.cells[techCell]?.textContent || '').replace(/\s+/g, ' ').trim() : '';
    return [part, tech].filter(Boolean).join(' — ') || 'Actions';
  }

  function showMenu(tr, x, y) {
    const actions = actionsFor(tr);
    if (!actions.length) return false;

    closeMenu();
    const m = document.createElement('div');
    m.className = 'row-context-menu';
    m.setAttribute('role', 'menu');

    const title = document.createElement('div');
    title.className = 'row-context-title';
    title.textContent = rowTitle(tr);
    m.appendChild(title);

    actions.forEach(a => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      b.disabled = a.disabled;
      b.setAttribute('role', 'menuitem');
      if (a.danger) b.classList.add('danger');
      b.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        if (!a.source.isConnected || a.source.disabled) return;
        setTimeout(() => a.source.click(), 0);
      });
      m.appendChild(b);
    });

    document.body.appendChild(m);
    menu = m;

    const pad = 8;
    const r = m.getBoundingClientRect();
    const left = Math.max(pad, Math.min(x, window.innerWidth - r.width - pad));
    const top = Math.max(pad, Math.min(y, window.innerHeight - r.height - pad));
    m.style.left = `${left}px`;
    m.style.top = `${top}px`;
    m.querySelector('button:not([disabled])')?.focus({ preventScroll:true });
    return true;
  }

  function makeTrigger(tr) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'row-menu-trigger';
    b.textContent = '⋮';
    b.title = 'More actions';
    b.setAttribute('aria-label', 'More actions');
    b.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const r = b.getBoundingClientRect();
      showMenu(tr, r.right - 2, r.bottom + 4);
    });
    return b;
  }

  function needsTrigger(tr) {
    const actions = actionsFor(tr);
    return actions.some(a => a.label !== 'Start' && a.label !== 'Complete');
  }

  function ensureAssignments() {
    const groups = [
      '#queuedBody tr',
      '#claimedActiveBody tr:not(.waiting-note-row)',
      '#claimedPausedBody tr:not(.waiting-note-row)',
      '#claimedWaitingBody tr:not(.waiting-note-row)',
      '#doneBody tr'
    ];

    document.querySelectorAll(groups.join(',')).forEach(tr => {
      if (!tr.cells?.length || tr.querySelector('.row-menu-trigger')) return;
      if (!needsTrigger(tr)) return;
      const cell = tr.cells[tr.cells.length - 1];
      if (!cell) return;
      cell.classList.add('context-actions-cell');
      cell.appendChild(makeTrigger(tr));
    });
  }

  function ensureHistory() {
    const table = document.getElementById('detailBody')?.closest('table');
    const head = table?.querySelector('thead tr');
    if (head && !head.querySelector('.context-actions-head')) {
      const th = document.createElement('th');
      th.className = 'context-actions-head';
      th.textContent = 'Actions';
      head.appendChild(th);
    }

    document.querySelectorAll('#detailBody tr').forEach(tr => {
      if (!tr.cells?.length) return;
      const empty = tr.querySelector('td.empty');
      if (empty) {
        empty.colSpan = 8;
        return;
      }
      if (tr.querySelector('.row-menu-trigger')) return;
      if (!actionsFor(tr).length) return;
      const td = document.createElement('td');
      td.className = 'context-actions-cell';
      td.appendChild(makeTrigger(tr));
      tr.appendChild(td);
    });
  }

  function ensure() {
    scheduled = false;
    if (onAssignments) ensureAssignments();
    if (onHistory) ensureHistory();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(ensure);
  }

  document.addEventListener('contextmenu', e => {
    if (e.target.closest('input,textarea,select,a,button,[contenteditable="true"]')) return;
    const tr = e.target.closest('tr');
    if (!tr) return;
    const inScope = tr.closest('#queuedBody,#claimedActiveBody,#claimedPausedBody,#claimedWaitingBody,#doneBody,#detailBody');
    if (!inScope) return;
    if (showMenu(tr, e.clientX, e.clientY)) e.preventDefault();
  }, true);

  document.addEventListener('mousedown', e => {
    if (menu && !e.target.closest('.row-context-menu') && !e.target.closest('.row-menu-trigger')) closeMenu();
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', closeMenu, true);

  function init() {
    injectStyle();
    new MutationObserver(schedule).observe(document.body, { childList:true, subtree:true });
    schedule();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true });
  else init();
})();
