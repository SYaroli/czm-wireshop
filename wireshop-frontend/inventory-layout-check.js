(() => {
  const path = window.location.pathname || '';
  const isInventoryList =
    path === '/inventory' ||
    path === '/inventory.html' ||
    path === '/inventory-list.html';

  if (!isInventoryList) return;

  let session = {};
  try { session = JSON.parse(localStorage.getItem('user') || '{}'); } catch {}

  const username = String(session.username || '').trim();
  const isAdmin = String(session.role || '').toLowerCase() === 'admin';
  const apiRoot = (localStorage.getItem('API_BASE') || 'https://wireshop-backend.onrender.com').replace(/\/+$/, '');
  const API_BASE = apiRoot.endsWith('/api') ? apiRoot : apiRoot + '/api';
  const BUILD_VALUES_URL = API_BASE + '/build-values';
  const valueMap = new Map();

  const style = document.createElement('style');
  style.id = 'inventoryLayoutCheckStyles';
  style.textContent = `
    @media (min-width:901px){
      .table-head,
      .list-body .row{
        grid-template-columns:150px 210px 90px 60px 150px 70px minmax(380px,1fr) !important;
      }
    }
    .build-value-cell{
      font-size:12px;
      font-weight:700;
      white-space:nowrap;
      display:flex;
      align-items:center;
      min-width:0;
    }
    .build-value-editor{
      display:flex;
      align-items:center;
      gap:5px;
    }
    .build-value-input{
      width:64px !important;
      min-width:64px !important;
      height:30px !important;
      padding:0 6px !important;
      text-align:center;
      border:1px solid #cfd4da !important;
      border-radius:6px !important;
    }
    .build-value-save{
      height:30px;
      min-width:46px;
      padding:0 7px;
      border:0;
      border-radius:6px;
      background:#c30000;
      color:#fff;
      font-size:11px;
      font-weight:700;
      cursor:pointer;
    }
    .build-value-save:disabled{opacity:.55;cursor:default;}
    .inventory-edit-cell{
      display:flex;
      align-items:center;
      min-width:0;
    }
    .inventory-edit-cell .edit-btn{
      min-width:58px;
      height:30px;
      padding:0 9px;
    }
    .notes-cell{
      padding-left:10px !important;
      white-space:normal !important;
      overflow-wrap:anywhere;
    }
    @media (max-width:900px){
      .table-head,
      .list-body .row{
        grid-template-columns:125px minmax(145px,1fr) 80px 45px 120px 60px !important;
      }
      .build-value-input{
        width:52px !important;
        min-width:52px !important;
      }
      .build-value-save{
        min-width:40px;
        padding:0 5px;
      }
      .notes-cell{
        grid-column:1 / -1 !important;
        margin-top:4px;
        padding-left:0 !important;
      }
    }
  `;
  document.head.appendChild(style);

  function formatValue(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  }

  function getPartNumber(row) {
    const link = row.querySelector('a[href^="/inv/"]');
    return String(link?.textContent || '').trim();
  }

  function getValue(partNumber) {
    return Number(valueMap.get(partNumber) || 0);
  }

  async function saveBuildValue(partNumber, input, button) {
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
      const res = await fetch(BUILD_VALUES_URL + '/' + encodeURIComponent(partNumber), {
        method:'PUT',
        headers:{
          'Content-Type':'application/json',
          'x-user':username
        },
        body:JSON.stringify({ buildValueHours:value })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Save failed');

      const saved = Number(data.buildValueHours || 0);
      valueMap.set(partNumber, saved);
      input.value = formatValue(saved);
      button.textContent = '✓';
      setTimeout(() => {
        if (button.isConnected) button.textContent = 'Save';
      }, 800);
    } catch (err) {
      button.textContent = oldText || 'Save';
      alert(err.message || 'Build Value save failed');
    } finally {
      button.disabled = false;
    }
  }

  function renderBuildValue(cell, partNumber) {
    const value = getValue(partNumber);

    if (!isAdmin) {
      cell.textContent = formatValue(value) + ' hrs';
      return;
    }

    let input = cell.querySelector('.build-value-input');
    let button = cell.querySelector('.build-value-save');

    if (!input || !button) {
      cell.innerHTML = '';

      const wrap = document.createElement('div');
      wrap.className = 'build-value-editor';

      input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.step = '0.25';
      input.className = 'build-value-input';
      input.setAttribute('aria-label', 'Build Value hours');

      button = document.createElement('button');
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

    if (document.activeElement !== input) {
      input.value = formatValue(value);
    }
  }

  function applyHeader() {
    const head = document.getElementById('tableHead') || document.querySelector('.table-head');
    if (!head) return;

    const wanted = [
      'Part Number',
      'Print Name',
      'Location',
      'Qty',
      'Build Value (hrs)',
      'Edit',
      'Notes'
    ];

    const current = Array.from(head.children).map(el => el.textContent.trim());
    if (current.length === wanted.length && current.every((v, i) => v === wanted[i])) return;

    head.innerHTML = '';
    wanted.forEach(text => {
      const cell = document.createElement('div');
      cell.textContent = text;
      head.appendChild(cell);
    });
  }

  function applyRows() {
    document.querySelectorAll('#listBody > .row').forEach(row => {
      const partNumber = getPartNumber(row);
      if (!partNumber) return;

      if (row.dataset.buildValueLayout === '1') {
        const valueCell = row.querySelector(':scope > .build-value-cell');
        if (valueCell) renderBuildValue(valueCell, partNumber);
        return;
      }

      const children = Array.from(row.children);
      if (children.length < 5) return;

      const notes = row.querySelector(':scope > .notes-cell') || children[children.length - 1];
      const controls = row.querySelector(':scope > .adjust-controls, :scope > .inventory-edit-cell');
      if (!notes || !controls) return;

      const firstFour = children.filter(el => el !== controls && el !== notes).slice(0, 4);
      if (firstFour.length !== 4) return;

      const buildValue = document.createElement('div');
      buildValue.className = 'build-value-cell';
      renderBuildValue(buildValue, partNumber);

      const editCell = document.createElement('div');
      editCell.className = 'inventory-edit-cell';
      if (isAdmin) {
        const editBtn = controls.querySelector('.edit-btn');
        if (editBtn) editCell.appendChild(editBtn);
      }

      row.innerHTML = '';
      firstFour.forEach(el => row.appendChild(el));
      row.appendChild(buildValue);
      row.appendChild(editCell);
      row.appendChild(notes);
      row.dataset.buildValueLayout = '1';
    });
  }

  function applyLayout() {
    applyHeader();
    applyRows();
  }

  async function loadBuildValues() {
    if (!username) return;

    try {
      const res = await fetch(BUILD_VALUES_URL, {
        headers:{ 'x-user':username }
      });
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error('Build Value load failed');

      valueMap.clear();
      (Array.isArray(data) ? data : []).forEach(row => {
        valueMap.set(
          String(row.partNumber || '').trim(),
          Number(row.buildValueHours || 0)
        );
      });
    } catch (err) {
      console.warn('[build-values]', err);
    }

    applyRows();
  }

  applyLayout();
  loadBuildValues();

  const listBody = document.getElementById('listBody');
  if (listBody) {
    const observer = new MutationObserver(() => requestAnimationFrame(applyLayout));
    observer.observe(listBody, { childList:true });
  }
})();
