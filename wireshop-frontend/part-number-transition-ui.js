(() => {
  const path = window.location.pathname || '';
  if (!path.startsWith('/inv/')) return;

  let session = {};
  try { session = JSON.parse(localStorage.getItem('user') || '{}'); } catch {}

  const username = String(session.username || '').trim();
  const isAdmin = String(session.role || '').toLowerCase() === 'admin';
  if (!username || !isAdmin) return;

  const API_BASE = 'https://wireshop-backend.onrender.com/api';

  function currentPartNumber() {
    try {
      return decodeURIComponent((window.location.pathname || '').replace(/^\/inv\//, '')).trim();
    } catch {
      return '';
    }
  }

  async function transitionPartNumber(button) {
    const oldPartNumber = currentPartNumber();
    if (!oldPartNumber) return;

    const newPartNumber = prompt(
      'New part number:\n\nCompleted Build History will NOT be changed.',
      oldPartNumber
    );
    if (newPartNumber === null) return;

    const next = String(newPartNumber || '').trim();
    if (!next || next.toLowerCase() === oldPartNumber.toLowerCase()) return;

    const ok = confirm(
      `Change current inventory and queued/in-progress Build Next work:\n\n${oldPartNumber}  →  ${next}\n\n` +
      'Timers will be preserved. Completed Build History and previous inventory movement will stay under the old part number.'
    );
    if (!ok) return;

    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = 'Changing…';

    try {
      const res = await fetch(`${API_BASE}/part-number-transition`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user': username
        },
        body: JSON.stringify({
          oldPartNumber,
          newPartNumber: next
        })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Part number change failed');

      alert(
        `Changed ${oldPartNumber} to ${next}.\n\n` +
        `${Number(data.activeTasksUpdated || 0)} queued/in-progress Build Next task(s) updated.\n` +
        'Completed Build History was left untouched.'
      );

      window.location.href = '/inv/' + encodeURIComponent(next);
    } catch (err) {
      alert(err.message || 'Part number change failed');
      button.disabled = false;
      button.textContent = oldText;
    }
  }

  function installButton() {
    if (document.getElementById('changePartNumberBtn')) return true;

    const bar = document.querySelector('.detail-topbar');
    if (!bar) return false;

    const button = document.createElement('button');
    button.id = 'changePartNumberBtn';
    button.type = 'button';
    button.className = 'toolbar-btn';
    button.textContent = 'Change Part #';
    button.style.background = '#3a3a3a';
    button.style.color = '#fff';
    button.style.borderColor = '#2b2b2b';
    button.addEventListener('click', () => transitionPartNumber(button));

    bar.appendChild(button);
    return true;
  }

  if (installButton()) return;

  const observer = new MutationObserver(() => {
    if (installButton()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
