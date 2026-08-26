(() => {
  const path = window.location.pathname || '';
  const isInventoryList =
    path === '/inventory' ||
    path === '/inventory.html' ||
    path === '/inventory-list.html';

  function renameMasterFileLabel() {
    const section = document.getElementById('komaxFileSection');
    if (!section) return;
    section.querySelectorAll('div').forEach((el) => {
      if (el.childElementCount === 0 && el.textContent.trim() === 'Komax Job File') {
        el.textContent = 'Master File';
      }
    });
  }

  if (!isInventoryList) {
    renameMasterFileLabel();
    const observer = new MutationObserver(renameMasterFileLabel);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return;
  }

  let session = {};
  try { session = JSON.parse(localStorage.getItem('user') || '{}'); } catch {}
  const isAdmin = String(session.role || '').toLowerCase() === 'admin';

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
    }
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
        grid-template-columns:125px minmax(145px,1fr) 80px 45px 95px 60px !important;
      }
      .notes-cell{
        grid-column:1 / -1 !important;
        margin-top:4px;
        padding-left:0 !important;
      }
    }
  `;
  document.head.appendChild(style);

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
      if (row.dataset.layoutCheck === '1') return;

      const children = Array.from(row.children);
      if (children.length < 5) return;

      const notes = row.querySelector(':scope > .notes-cell') || children[children.length - 1];
      const controls = row.querySelector(':scope > .adjust-controls, :scope > .inventory-edit-cell');
      if (!notes || !controls) return;

      const firstFour = children.filter(el => el !== controls && el !== notes).slice(0, 4);
      if (firstFour.length !== 4) return;

      const buildValue = document.createElement('div');
      buildValue.className = 'build-value-cell';
      buildValue.textContent = '0 hrs';
      buildValue.title = 'Layout check only — saving is not wired yet.';

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
      row.dataset.layoutCheck = '1';
    });
  }

  function applyLayout() {
    applyHeader();
    applyRows();
  }

  applyLayout();

  const listBody = document.getElementById('listBody');
  if (listBody) {
    const observer = new MutationObserver(() => requestAnimationFrame(applyLayout));
    observer.observe(listBody, { childList: true });
  }
})();
