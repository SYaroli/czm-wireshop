(() => {
  const CIRRIS_API_BASE = 'https://wireshop-backend.onrender.com/api';

  function getPartNumber() {
    const path = window.location.pathname || '';
    if (!path.startsWith('/inv/')) return null;
    const pn = decodeURIComponent(path.slice('/inv/'.length)).trim();
    return pn || null;
  }

  function getUser() {
    try { return JSON.parse(localStorage.getItem('user') || 'null'); }
    catch { return null; }
  }

  function username() {
    const u = getUser();
    return String(u?.username || u?.name || u?.user || '').trim();
  }

  function isAdmin() {
    return String(getUser()?.role || '').toLowerCase() === 'admin';
  }

  function esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function actionButton(label, kind = 'gray') {
    const colors = kind === 'green'
      ? 'background:#1a6b3a;color:#fff;border:1px solid #155b31;'
      : kind === 'red'
      ? 'background:#c30000;color:#fff;border:1px solid #a00000;'
      : 'background:#eee;color:#111;border:1px solid #cfd4da;';
    return `${colors}padding:8px 14px;border-radius:6px;font-weight:700;font-size:.86rem;white-space:nowrap;cursor:pointer;`;
  }

  function setStatus(section, text) {
    section.innerHTML = `
      <div style="padding:10px 14px;background:#f5f7fa;border:1px solid #d7dde5;border-radius:8px;font-size:.85rem;">
        ${esc(text)}
      </div>`;
  }

  async function fileToBase64(file) {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return btoa(binary);
  }

  function chooseWorkbook(partNumber, section) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    input.style.display = 'none';

    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.xlsx')) {
        alert('Please select an .xlsx Cirris setup form.');
        return;
      }

      try {
        setStatus(section, `Uploading ${file.name}...`);
        const file_data = await fileToBase64(file);
        const res = await fetch(`${CIRRIS_API_BASE}/cirris-forms`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-user': username(),
          },
          body: JSON.stringify({
            part_number: partNumber,
            filename: file.name,
            file_data,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Upload failed');
        await refresh(partNumber, section);
      } catch (e) {
        alert(e.message || 'Upload failed');
        await refresh(partNumber, section);
      }
    });

    document.body.appendChild(input);
    input.click();
  }

  async function createBlank(partNumber, section) {
    try {
      setStatus(section, 'Creating blank Cirris setup form...');
      const res = await fetch(`${CIRRIS_API_BASE}/cirris-forms/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user': username(),
        },
        body: JSON.stringify({ part_number: partNumber }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Create failed');
      await refresh(partNumber, section);
    } catch (e) {
      alert(e.message || 'Create failed');
      await refresh(partNumber, section);
    }
  }

  async function refresh(partNumber, section) {
    setStatus(section, 'Loading Cirris setup form...');

    try {
      const res = await fetch(
        `${CIRRIS_API_BASE}/cirris-forms/check?part_number=${encodeURIComponent(partNumber)}`,
        { headers: { 'x-user': username() } }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to check Cirris form');

      if (!data.exists) {
        section.innerHTML = `
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;
                      padding:10px 14px;background:#f5f8ff;border:1px solid #cbdaf3;
                      border-radius:8px;">
            <span style="font-size:1.3rem;">🧪</span>
            <div style="flex:1;min-width:220px;">
              <div style="font-weight:700;font-size:.9rem;">Cirris Setup Form</div>
              <div style="font-size:.8rem;opacity:.7;">No form created yet</div>
            </div>
            ${isAdmin() ? `
              <button id="cirrisCreateBlank" type="button" style="${actionButton('Create Blank', 'green')}">Create Blank</button>
              <button id="cirrisUploadExisting" type="button" style="${actionButton('Upload Existing', 'gray')}">Upload Existing</button>
            ` : ''}
          </div>`;

        document.getElementById('cirrisCreateBlank')?.addEventListener('click', () => createBlank(partNumber, section));
        document.getElementById('cirrisUploadExisting')?.addEventListener('click', () => chooseWorkbook(partNumber, section));
        return;
      }

      const f = data.file;
      const sourceText = f.source === 'blank' ? 'blank created by' : 'uploaded by';
      section.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;
                    padding:10px 14px;background:#f5f8ff;border:1px solid #cbdaf3;
                    border-radius:8px;">
          <span style="font-size:1.3rem;">🧪</span>
          <div style="flex:1;min-width:220px;">
            <div style="font-weight:700;font-size:.9rem;">Cirris Setup Form</div>
            <div style="font-size:.8rem;opacity:.7;">${esc(f.filename)} &middot; ${sourceText} ${esc(f.uploaded_by)}</div>
          </div>
          <a href="${CIRRIS_API_BASE}/cirris-forms/${encodeURIComponent(f.id)}/download"
             style="${actionButton('Download', 'green')}text-decoration:none;">⬇ Download</a>
          ${isAdmin() ? `<button id="cirrisReplace" type="button" style="${actionButton('Replace', 'gray')}">Replace</button>` : ''}
        </div>`;

      document.getElementById('cirrisReplace')?.addEventListener('click', () => chooseWorkbook(partNumber, section));
    } catch (e) {
      section.innerHTML = `
        <div style="padding:10px 14px;background:#fff4f4;border:1px solid #efc5c5;border-radius:8px;font-size:.82rem;">
          Cirris form unavailable: ${esc(e.message || 'unknown error')}
        </div>`;
    }
  }

  function mount() {
    const partNumber = getPartNumber();
    if (!partNumber) return false;

    const komax = document.getElementById('komaxFileSection');
    if (!komax) return false;

    let section = document.getElementById('cirrisFormSection');
    if (!section) {
      section = document.createElement('div');
      section.id = 'cirrisFormSection';
      section.style.marginTop = '8px';
      komax.insertAdjacentElement('afterend', section);
    }

    if (!section.dataset.loaded) {
      section.dataset.loaded = '1';
      refresh(partNumber, section);
    }
    return true;
  }

  if (!mount()) {
    const observer = new MutationObserver(() => {
      if (mount()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 15000);
  }
})();
