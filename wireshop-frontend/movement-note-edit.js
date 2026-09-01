(() => {
  const path = window.location.pathname || '';
  if (!path.startsWith('/inv/')) return;

  let session = {};
  try { session = JSON.parse(localStorage.getItem('user') || '{}'); } catch {}

  const username = String(session.username || '').trim();
  const isAdmin = String(session.role || '').toLowerCase() === 'admin';
  if (!username || isAdmin) return; // admins already have the built-in Edit/Delete column

  const API_BASE = 'https://wireshop-backend.onrender.com/api';
  let movementRows = [];
  let loading = false;

  function partNumber() {
    try {
      return decodeURIComponent(path.replace(/^\/inv\//, '')).trim();
    } catch {
      return '';
    }
  }

  async function loadRows() {
    const pn = partNumber();
    if (!pn || loading) return;
    loading = true;

    try {
      const res = await fetch(`${API_BASE}/inventory/${encodeURIComponent(pn)}/log`, {
        headers: { 'x-user': username }
      });
      const data = await res.json().catch(() => []);
      if (res.ok && Array.isArray(data)) movementRows = data;
    } catch (err) {
      console.warn('[movement-note-edit]', err);
    } finally {
      loading = false;
      installButtons();
    }
  }

  async function editNote(rowData, tr, button) {
    const id = Number(rowData?.id);
    if (!Number.isFinite(id) || !id) return;

    const current = String(rowData?.note || rowData?.notes || '');
    const next = prompt('Edit note:', current);
    if (next === null) return;

    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = '...';

    try {
      const res = await fetch(`${API_BASE}/inventory-log/${id}/note`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-user': username
        },
        body: JSON.stringify({ note: next })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Update failed');

      rowData.note = next;
      const cells = tr.querySelectorAll('td');
      if (cells[4]) cells[4].textContent = next;

      button.textContent = '✓';
      setTimeout(() => {
        if (button.isConnected) button.textContent = 'Edit';
      }, 700);
    } catch (err) {
      button.textContent = oldText || 'Edit';
      alert(err.message || 'Update failed');
    } finally {
      button.disabled = false;
    }
  }

  function installButtons() {
    const table = document.querySelector('#movementBox table');
    if (!table || !movementRows.length) return;

    const headerRow = table.querySelector('thead tr');
    if (headerRow && !headerRow.querySelector('.tech-note-edit-head')) {
      const th = document.createElement('th');
      th.className = 'tech-note-edit-head';
      th.textContent = 'Note';
      th.style.padding = '6px 4px';
      headerRow.appendChild(th);
    }

    const rows = Array.from(table.querySelectorAll('tbody tr'));
    rows.forEach((tr, index) => {
      const rowData = movementRows[index];
      if (!rowData || tr.querySelector('.tech-note-edit-cell')) return;

      const td = document.createElement('td');
      td.className = 'tech-note-edit-cell';
      td.style.padding = '6px 4px';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'log-btn';
      button.textContent = 'Edit';
      button.addEventListener('click', () => editNote(rowData, tr, button));

      td.appendChild(button);
      tr.appendChild(td);
    });
  }

  const observer = new MutationObserver(() => installButtons());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadRows, { once: true });
  } else {
    loadRows();
  }
})();
