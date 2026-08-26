(() => {
  // Keep the existing Master File label cleanup.
  const OLD_LABEL = 'Komax Job File';
  const NEW_LABEL = 'Master File';

  function renameMasterFileLabel() {
    const section = document.getElementById('komaxFileSection');
    if (!section) return;

    section.querySelectorAll('div').forEach((el) => {
      if (el.childElementCount === 0 && el.textContent.trim() === OLD_LABEL) {
        el.textContent = NEW_LABEL;
      }
    });
  }

  const path = window.location.pathname || '';
  const isInventoryPage = path === '/inventory' || path === '/inventory.html' || path.startsWith('/inv/');
  if (!isInventoryPage) {
    renameMasterFileLabel();
    const labelObserver = new MutationObserver(renameMasterFileLabel);
    labelObserver.observe(document.documentElement, { childList: true, subtree: true });
    return;
  }

  let session = {};
  try { session = JSON.parse(localStorage.getItem('user') || '{}'); } catch {}
  const username = String(session.username || '').trim();
  const isAdmin = String(session.role || '').toLowerCase() === 'admin';
  const API_ROOT = (localStorage.getItem('API_BASE') || 'https://wireshop-backend.onrender.com').replace(/\/+$/, '');
  const VALUE_API = API_ROOT + '/api/build-values';
  const valueMap = new Map();
  let uiQueued = false;

  function addBuildValueStyles() {
    if (document.getElementById('buildValueStyles')) return;
    const style = document.createElement('style');
    style.id = 'buildValueStyles';
    style.textContent = `
      @media (min-width:901px){
        body:not(.inv-detail) .table-head,
        body:not(.inv-detail) .list-body .row{
          grid-template-columns:150px 210px 90px 60px 120px 74px minmax(320px,1fr) !important;
        }
      }
      .build-value-head{white-space:nowrap;}
      .build-value-cell{font-size:12px;font-weight:700;display:flex;align-items:center;gap:5px;min-width:0;}
      .build-value-editor{display:flex;align-items:center;gap:4px;}
      .build-value-input{
        width:58px !important;
        min-width:58px !important;
        height:30px !important;
        padding:0 6px !important;
        text-align:center;
        border-radius:6px !important;
      }
      .build-value-save{
        min-width:38px;
        height:30px;
        padding:0 7px;
        border-radius:6px;
        font-size:11px;
      }
      body:not(.inv-detail) .adjust-controls{
        min-width:0;
        gap:0;
      }
      body:not(.inv-detail) .adjust-controls .edit-btn{
        min-width:58px;
        height:30px;
        padding:0 9px;
      }
      .build-value-detail-control{display:flex;align-items:center;gap:6px;justify-content:flex-start;}
      .build-value-detail-control .build-value-input{width:80px !important;min-width:80px !important;}
      @media(max-width:900px){
        body:not(.inv-detail) .build-value-head,
        body:not(.inv-detail) .build-value-cell{display:none !important;}
      }
    `;
    document.head.appendChild(style);
  }

  function formatValue(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  }

  function getValue(partNumber) {
    return Number(valueMap.get(String(partNumber || '')) || 0);
  }

  async function saveBuildValue(partNumber, input, button) {
    if (!isAdmin || !partNumber) return;
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < 0) {
      alert('Build Value must be zero or greater.');
      input.value = formatValue(getValue(partNumber));
      return;
    }

    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = '...';
    try {
      const res = await fetch(VALUE_API + '/' + encodeURIComponent(partNumber), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-user': username },
        body: JSON.stringify({ buildValueHours: value })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Save failed');
      const saved = Number(data.buildValueHours || 0);
      valueMap.set(partNumber, saved);
      input.value = formatValue(saved);
      button.textContent = '✓';
      setTimeout(() => { button.textContent = 'Save'; }, 900);
      applyBuildValueUi();
    } catch (err) {
      alert(err.message || 'Build Value save failed');
      button.textContent = oldText || 'Save';
    } finally {
      button.disabled = false;
    }
  }

  function renderValueControl(container, partNumber, detailMode = false) {
    const value = getValue(partNumber);
    container.dataset.partNumber = partNumber;

    if (!isAdmin) {
      const text = formatValue(value) + ' hrs';
      if (container.textContent !== text) container.textContent = text;
      return;
    }

    let input = container.querySelector('.build-value-input');
    let button = container.querySelector('.build-value-save');
    if (!input || !button) {
      container.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = detailMode ? 'build-value-editor build-value-detail-control' : 'build-value-editor';

      input = document.createElement('input');
      input.className = 'build-value-input';
      input.type = 'number';
      input.min = '0';
      input.step = '0.25';
      input.setAttribute('aria-label', 'Build Value hours');

      button = document.createElement('button');
      button.className = 'build-value-save';
      button.type = 'button';
      button.textContent = 'Save';
      button.title = 'Save Build Value hours';
      button.addEventListener('click', () => saveBuildValue(partNumber, input, button));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          button.click();
        }
      });

      wrap.append(input, button);
      container.appendChild(wrap);
    }

    if (document.activeElement !== input) input.value = formatValue(value);
  }

  function applyListHeader() {
    const head = document.getElementById('tableHead');
    if (!head) return;

    const editHead = Array.from(head.children).find(el => {
      const text = el.textContent.trim();
      return text === 'Adjust' || text === 'Edit';
    });
    if (!editHead) return;
    editHead.textContent = 'Edit';

    if (head.querySelector('.build-value-head')) return;

    const valueHead = document.createElement('div');
    valueHead.className = 'build-value-head';
    valueHead.textContent = 'Build Value (hrs)';
    head.insertBefore(valueHead, editHead);
  }

  function simplifyListControls(row) {
    const controls = row.querySelector(':scope > .adjust-controls');
    if (!controls) return null;

    Array.from(controls.children).forEach(child => {
      if (!child.classList.contains('edit-btn')) child.remove();
    });

    return controls;
  }

  function applyListRows() {
    document.querySelectorAll('#listBody > .row').forEach(row => {
      const partLink = row.querySelector('a[href^="/inv/"]');
      const partNumber = String(partLink?.textContent || '').trim();
      if (!partNumber) return;

      const editControls = simplifyListControls(row);
      if (!editControls) return;

      let cell = row.querySelector(':scope > .build-value-cell');
      if (!cell) {
        cell = document.createElement('div');
        cell.className = 'build-value-cell';
        row.insertBefore(cell, editControls);
      }
      renderValueControl(cell, partNumber, false);
    });
  }

  function applyDetailValue() {
    const grid = document.querySelector('.detail-grid');
    if (!grid) return;

    const routeMatch = (window.location.pathname || '').match(/^\/inv\/(.+)$/);
    const partNumber = routeMatch ? decodeURIComponent(routeMatch[1]) : '';
    if (!partNumber) return;

    let label = grid.querySelector('.build-value-detail-label');
    let valueCell = grid.querySelector('.build-value-detail-value');
    if (!label || !valueCell) {
      label = document.createElement('div');
      label.className = 'build-value-detail-label';
      label.innerHTML = '<b>Build Value (hrs)</b>';
      valueCell = document.createElement('div');
      valueCell.className = 'build-value-detail-value';
      grid.append(label, valueCell);
    }
    renderValueControl(valueCell, partNumber, true);
  }

  function applyBuildValueUi() {
    addBuildValueStyles();
    renameMasterFileLabel();
    applyListHeader();
    applyListRows();
    applyDetailValue();
  }

  function queueUi() {
    if (uiQueued) return;
    uiQueued = true;
    requestAnimationFrame(() => {
      uiQueued = false;
      applyBuildValueUi();
    });
  }

  async function loadBuildValues() {
    if (!username) return;
    try {
      const res = await fetch(VALUE_API, { headers: { 'x-user': username } });
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error(data.error || 'Failed to load build values');
      valueMap.clear();
      (Array.isArray(data) ? data : []).forEach(row => {
        valueMap.set(String(row.partNumber || ''), Number(row.buildValueHours || 0));
      });
    } catch (err) {
      console.warn('[build-values]', err);
    }
    applyBuildValueUi();
  }

  addBuildValueStyles();
  applyBuildValueUi();
  loadBuildValues();

  const observer = new MutationObserver(queueUi);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();