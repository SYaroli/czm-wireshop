// Compact, consistent controls for Build Next / Build History.
(() => {
  if (window.__wireShopUiPolishLoaded) return;
  window.__wireShopUiPolishLoaded = true;

  const path = String(location.pathname || '').toLowerCase();
  const onAssignments = path.endsWith('/assignments.html') || path === '/assignments';
  const onHistory = path.endsWith('/build-history.html') || path === '/build-history';
  if (!onAssignments && !onHistory) return;

  let queued = false;

  function injectStyle() {
    if (document.getElementById('wireShopUiPolishStyle')) return;
    const s = document.createElement('style');
    s.id = 'wireShopUiPolishStyle';
    s.textContent = `
      /* Keep the remaining controls compact and visually consistent. */
      #tblQueued td, .progress-table td, #tblDone td { vertical-align:middle; }

      #tblQueued .pill.small,
      .progress-table .pill.small,
      #tblDone .pill.small,
      .waiting-note-save {
        min-width:0 !important;
        height:28px !important;
        padding:3px 9px !important;
        border-radius:6px !important;
        font-size:12px !important;
        line-height:1 !important;
        font-weight:800 !important;
        box-shadow:none !important;
      }

      #addBtn {
        height:32px !important;
        min-width:72px !important;
        padding:4px 12px !important;
        border-radius:7px !important;
        font-size:12px !important;
        box-shadow:none !important;
      }

      #qAdd, #prioritySel {
        height:32px;
        padding-top:3px;
        padding-bottom:3px;
        border-radius:7px;
      }

      .claimed-action-row {
        gap:5px !important;
        justify-content:flex-end !important;
        align-items:center !important;
      }

      .claimed-action-row .qtyDone {
        width:70px !important;
        min-width:70px !important;
        height:28px !important;
        padding:3px 7px !important;
        border-radius:6px !important;
        font-size:12px !important;
      }

      .row-menu-trigger {
        min-width:28px !important;
        width:28px !important;
        height:28px !important;
        border-radius:6px !important;
        font-size:18px !important;
        line-height:22px !important;
        box-shadow:none !important;
        color:#34383e !important;
      }

      .context-actions-cell {
        width:38px;
        min-width:38px;
        padding-left:5px !important;
        padding-right:5px !important;
        text-align:center !important;
      }

      .context-actions-head {
        width:38px;
        min-width:38px;
        text-align:center !important;
      }

      /* Save is useful but secondary; don't let it compete visually with Complete. */
      .waiting-note-save {
        background:#fff !important;
        color:#333 !important;
        border:1px solid #bfc5ce !important;
      }
      .waiting-note-save:hover {
        background:#f3f5f7 !important;
        border-color:#929aa6 !important;
      }

      .waiting-note-wrap {
        gap:7px !important;
        align-items:center !important;
      }

      .waitingNoteBox {
        min-height:34px !important;
        padding:7px 8px !important;
        border-radius:6px !important;
      }

      /* Done header: Export is primary; Clear is deliberately quieter/destructive. */
      #doneActions {
        display:flex;
        align-items:center;
        gap:6px;
      }
      #clearDoneBtn, #exportDoneBtn {
        height:28px !important;
        padding:3px 9px !important;
        border-radius:6px !important;
        font-size:12px !important;
        line-height:1 !important;
        box-shadow:none !important;
      }
      #clearDoneBtn {
        background:#fff !important;
        color:#a00000 !important;
        border:1px solid #a00000 !important;
      }
      #clearDoneBtn:hover { background:#fff2f2 !important; }

      /* History controls use the same compact visual language. */
      #refreshBtn, #clearBtn, #exportBtn {
        height:30px !important;
        padding:3px 10px !important;
        border-radius:6px !important;
        font-size:12px !important;
      }
    `;
    document.head.appendChild(s);
  }

  function ensureDoneActionsColumn() {
    if (!onAssignments) return;
    const body = document.getElementById('doneBody');
    const table = body?.closest('table');
    const head = table?.querySelector('thead tr');
    if (!body || !head) return;

    if (!head.querySelector('.context-actions-head')) {
      const th = document.createElement('th');
      th.className = 'context-actions-head';
      th.textContent = '';
      th.setAttribute('aria-label', 'Actions');
      head.appendChild(th);
    }

    [...body.querySelectorAll('tr')].forEach(tr => {
      if (!tr.cells?.length) return;
      const trigger = tr.querySelector('.row-menu-trigger');
      if (!trigger) return;

      let cell = tr.querySelector('td.context-actions-cell[data-polish-actions="1"]');
      if (!cell) {
        cell = document.createElement('td');
        cell.className = 'context-actions-cell';
        cell.dataset.polishActions = '1';
        tr.appendChild(cell);
      }
      if (trigger.parentElement !== cell) cell.appendChild(trigger);
    });
  }

  function alignProgressMenus() {
    if (!onAssignments) return;
    document.querySelectorAll('#claimedActiveBody tr:not(.waiting-note-row),#claimedPausedBody tr:not(.waiting-note-row),#claimedWaitingBody tr:not(.waiting-note-row)').forEach(tr => {
      const trigger = tr.querySelector('.row-menu-trigger');
      const row = tr.querySelector('.claimed-action-row');
      if (trigger && row && trigger.parentElement !== row) row.appendChild(trigger);
    });
  }

  function alignQueueMenus() {
    if (!onAssignments) return;
    document.querySelectorAll('#queuedBody tr').forEach(tr => {
      const trigger = tr.querySelector('.row-menu-trigger');
      if (!trigger) return;
      const cell = tr.cells?.[tr.cells.length - 1];
      if (!cell) return;
      cell.style.display = 'flex';
      cell.style.alignItems = 'center';
      cell.style.justifyContent = 'flex-end';
      cell.style.gap = '5px';
    });
  }

  function fixEmptyDoneRows() {
    if (!onAssignments) return;
    document.querySelectorAll('#doneBody tr').forEach(tr => {
      if (tr.cells?.length === 1 && tr.cells[0].hasAttribute('colspan')) tr.cells[0].colSpan = 7;
    });
  }

  function ensure() {
    queued = false;
    alignProgressMenus();
    alignQueueMenus();
    ensureDoneActionsColumn();
    fixEmptyDoneRows();
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(ensure);
  }

  function init() {
    injectStyle();
    new MutationObserver(schedule).observe(document.body, { childList:true, subtree:true });
    schedule();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true });
  else init();
})();
