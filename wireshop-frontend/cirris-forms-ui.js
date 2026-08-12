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

  function formatDateOnly(value) {
    const s = String(value || '').trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
    return s || '';
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

  function filenameFromDisposition(header, fallback) {
    const match = String(header || '').match(/filename="?([^";]+)"?/i);
    return match?.[1] || fallback;
  }

  async function downloadBlank() {
    const button = document.getElementById('cirrisDownloadBlank');
    const oldText = button?.textContent || 'Download Blank Form';

    if (button) {
      button.disabled = true;
      button.textContent = 'Downloading...';
      button.style.opacity = '.65';
    }

    try {
      const res = await fetch(`${CIRRIS_API_BASE}/cirris-forms/blank/download`, {
        headers: { 'x-user': username() },
      });

      if (!res.ok) {
        let data = {};
        try { data = await res.json(); } catch {}
        throw new Error(data?.error || 'Blank form download failed');
      }

      const blob = await res.blob();
      const filename = filenameFromDisposition(
        res.headers.get('Content-Disposition'),
        'Blank Cirris Test.xlsx'
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      alert(e.message || 'Blank form download failed');
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText;
        button.style.opacity = '1';
      }
    }
  }

  async function generateTest(formId, partNumber) {
    const button = document.getElementById('cirrisGenerate');
    const oldText = button?.textContent || 'Generate Test';

    if (button) {
      button.disabled = true;
      button.textContent = 'Generating...';
      button.style.opacity = '.65';
    }

    try {
      const res = await fetch(`${CIRRIS_API_BASE}/cirris-forms/${encodeURIComponent(formId)}/generate`, {
        headers: { 'x-user': username() },
      });

      if (!res.ok) {
        let data = {};
        try { data = await res.json(); } catch {}
        const details = Array.isArray(data?.details) && data.details.length
          ? `\n\n${data.details.join('\n')}`
          : '';
        throw new Error(`${data?.error || 'Generate failed'}${details}`);
      }

      const blob = await res.blob();
      const fallback = `${String(partNumber || 'HARNESS').replace(/\./g, '_')}_CIRRIS.txt`;
      const filename = filenameFromDisposition(res.headers.get('Content-Disposition'), fallback);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      alert(e.message || 'Generate failed');
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText;
        button.style.opacity = '1';
      }
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
              <div style="font-size:.8rem;opacity:.7;">Not set up — download the blank form, complete it, then upload it here.</div>
            </div>
            <button id="cirrisDownloadBlank" type="button" style="${actionButton('Download Blank Form', 'green')}">⬇ Download Blank Form</button>
            ${isAdmin() ? `
              <button id="cirrisUploadExisting" type="button" style="${actionButton('Upload Completed Form', 'gray')}">Upload Completed Form</button>
            ` : ''}
          </div>`;

        document.getElementById('cirrisDownloadBlank')?.addEventListener('click', downloadBlank);
        document.getElementById('cirrisUploadExisting')?.addEventListener('click', () => chooseWorkbook(partNumber, section));
        return;
      }

      const f = data.file;
      const dateText = formatDateOnly(f.uploaded_at);
      section.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;
                    padding:10px 14px;background:#f5f8ff;border:1px solid #cbdaf3;
                    border-radius:8px;">
          <span style="font-size:1.3rem;">🧪</span>
          <div style="flex:1;min-width:220px;">
            <div style="font-weight:700;font-size:.9rem;">Cirris Setup Form</div>
            <div style="font-size:.8rem;opacity:.7;">${esc(f.filename)} &middot; uploaded by ${esc(f.uploaded_by)}${dateText ? ` on ${esc(dateText)}` : ''}</div>
          </div>
          ${isAdmin() ? `<button id="cirrisGenerate" type="button" style="${actionButton('Generate Test', 'red')}">Generate Test</button>` : ''}
          <a href="${CIRRIS_API_BASE}/cirris-forms/${encodeURIComponent(f.id)}/download"
             style="${actionButton('Download Form', 'green')}text-decoration:none;">⬇ Download Form</a>
          ${isAdmin() ? `<button id="cirrisReplace" type="button" style="${actionButton('Replace Form', 'gray')}">Replace Form</button>` : ''}
        </div>`;

      document.getElementById('cirrisGenerate')?.addEventListener('click', () => generateTest(f.id, partNumber));
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
