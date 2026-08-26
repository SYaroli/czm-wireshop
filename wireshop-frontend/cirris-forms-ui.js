(() => {
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
    const observer = new MutationObserver(renameMasterFileLabel);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return;
  }

  let session = {};
  try { session = JSON.parse(localStorage.getItem('user') || '{}'); } catch {}

  const username = String(session.username || '').trim();
  const isAdmin = String(session.role || '').toLowerCase() === 'admin';
  const API_ROOT = (localStorage.getItem('API_BASE') || 'https://wireshop-backend.onrender.com').replace(/\/+$/, '');
  const VALUE_API = API_ROOT + '/api/build-values';
  const valueMap = new Map();

  function addStyles() {
    if (document.getElementById('buildValueStyles')) return;
    const style = document.createElement('style');
    style.id = 'buildValueStyles';
    style.textContent = `
      @media (min-width:901px){
        body:not(.inv-detail) .table-head,
        body:not(.inv-detail) .list-body .row{
          grid-template-columns:150px 210px 90px 60px 150px 70px minmax(380px,1fr) !important;
        }
      }
      .build-value-head{white-space:nowrap;}
      .build-value-cell{font-size:12px;font-weight:700;display:flex;align-items:center;min-width:0;}
      .build-value-editor{display:flex;align-items:center;gap:5px;}
      .build-value-input{
        width:72px !important;
        min-width:72px !important;
        height:30px !important;
        padding:0 6px !important;
        text-align:center;
        border:1px solid #cfd4da !important;
        border-radius:6px !important;
      }
      .build-value-save{
        background:#c30000;
        color:#fff;
        border:none;
        border-radius:6px;
        height:30px;
        min-width:48px;
        padding:0 8px;
        font-size:11px;
        font-weight:700;
        cursor:pointer;
      }
      .inventory-edit-cell{display:flex;align-items:center;min-width:0;}
      .inventory-edit-cell .edit-btn{min-width:58px;height:30px;padding:0 9px;}
      body:not(.inv-detail) .notes-cell{padding-left:10px;}
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

    button.disabled = true;
    const original = button.textContent;
    button.textContent = '...';

    try {
      const res = await fetch(VALUE_API + '/' + encodeURIComponent(partNumber), {
        method: 'PUT',
        headers: { 'Content-Type':'application/json', 'x-user': username },
        body: JSON.stringify({ buildValueHours: value })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Save failed');

      const saved = Number(data.buildValueHours || 0);
      valueMap.set(partNumber, saved);
      input.value = formatValue(saved);
      button.textContent = '✓';
      setTimeout(() => { button.textContent = 'Save'; }, 800);
    } catch (err) {
      button.textContent = original || 'Save';
      alert(err.message || 'Build Value save failed');
    } finally {
      button.disabled = false;
    }
  }

  function renderValueCell(cell, partNumber, detailMode = false) {
    const value = getValue(partNumber);

    if (!isAdmin) {
      cell.textContent = formatValue(value) + ' hrs';
      return;
    }

    if (!cell.querySelector('.build-value-input')) {
      cell.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = detailMode ? 'build-value-editor build-value-detail-control' : 'build-value-editor';

      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.step = '0.25';
      input.className = 'build-value-input';
      input.setAttribute('aria-label', 'Build Value hours');

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'build-value-save';
      button.textContent = 'Save';
      button.addEventListener('click', () => saveBuildValue(partNumber, input, button));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          button.click();
        }
      });

      wrap.append(input, button);
      cell.appendChild(wrap);
    }

    const input = cell.querySelector('.build-value-input');
    if (input && document.activeElement !== input) input.value = formatValue(value);
  }

  function rebuildListHeader() {
    if (document.body.classList.contains('inv-detail')) return;
    const head = document.getElementById('tableHead');
    if (!head) return;

    const wanted = ['Part Number','Print Name','Location','Qty','Build Value (hrs)','Edit','Notes'];
    const current = Array.from(head.children).map(el => el.textContent.trim());
    if (current.length === wanted.length && current.every((v,i) => v === wanted[i])) return;

    head.innerHTML = '';
    wanted.forEach((text, i) => {
      const div = document.createElement('div');
      div.textContent = text;
      if (i === 4) div.className = 'build-value-head';
      head.appendChild(div);
    });
  }

  function rebuildListRows() {
    if (document.body.classList.contains('inv-detail')) return;

    document.querySelectorAll('#listBody > .row').forEach(row => {
      const children = Array.from(row.children);
      const partLink = row.querySelector('a[href^="/inv/"]');
      const partNumber = String(partLink?.textContent || '').trim();
      if (!partNumber) return;

      const notes = row.querySelector(':scope > .notes-cell');
      const controls = row.querySelector(':scope > .adjust-controls, :scope > .inventory-edit-cell');
      if (!notes || !controls) return;

      let valueCell = row.querySelector(':scope > .build-value-cell');
      if (!valueCell) {
        valueCell = document.createElement('div');
        valueCell.className = 'build-value-cell';
        row.insertBefore(valueCell, controls);
      }
      renderValueCell(valueCell, partNumber, false);

      controls.classList.remove('adjust-controls');
      controls.classList.add('inventory-edit-cell');
      Array.from(controls.children).forEach(child => {
        if (!child.classList.contains('edit-btn')) child.remove();
      });

      // Keep the exact seven-column order even if older helper code touched this row.
      const firstFour = children.filter(el =>
        el !== notes &&
        el !== controls &&
        !el.classList.contains('build-value-cell')
      ).slice(0,4);

      if (firstFour.length === 4) {
        row.innerHTML = '';
        firstFour.forEach(el => row.appendChild(el));
        row.appendChild(valueCell);
        row.appendChild(controls);
        row.appendChild(notes);
      }
    });
  }

  function applyDetailValue() {
    const grid = document.querySelector('.detail-grid');
    if (!grid) return;

    const match = (window.location.pathname || '').match(/^\/inv\/(.+)$/);
    const partNumber = match ? decodeURIComponent(match[1]) : '';
    if (!partNumber) return;

    let label = grid.querySelector('.build-value-detail-label');
    let cell = grid.querySelector('.build-value-detail-value');

    if (!label || !cell) {
      label = document.createElement('div');
      label.className = 'build-value-detail-label';
      label.innerHTML = '<b>Build Value (hrs)</b>';

      cell = document.createElement('div');
      cell.className = 'build-value-detail-value';
      grid.append(label, cell);
    }

    renderValueCell(cell, partNumber, true);
  }

  function applyUi() {
    addStyles();
    renameMasterFileLabel();
    rebuildListHeader();
    rebuildListRows();
    applyDetailValue();
  }

  async function loadBuildValues() {
    if (!username) {
      applyUi();
      return;
    }

    try {
      const res = await fetch(VALUE_API, { headers: { 'x-user': username } });
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error('Failed to load build values');

      valueMap.clear();
      (Array.isArray(data) ? data : []).forEach(row => {
        valueMap.set(String(row.partNumber || ''), Number(row.buildValueHours || 0));
      });
    } catch (err) {
      console.warn('[build-values]', err);
    }

    applyUi();
  }

  addStyles();
  applyUi();
  loadBuildValues();

  const listBody = document.getElementById('listBody');
  if (listBody) {
    const observer = new MutationObserver(() => requestAnimationFrame(applyUi));
    observer.observe(listBody, { childList: true });
  }
})();