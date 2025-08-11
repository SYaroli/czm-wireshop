document.addEventListener('DOMContentLoaded', () => {
  const user = JSON.parse(localStorage.getItem('user'));
  const API_URL = 'https://czm-wireshop.onrender.com/api/jobs';
  let activeLogs = new Set();
  let updateTimer;

  // ----- Login -----
  const loginForm = document.getElementById('login-form');
  const errorMessage = document.getElementById('error-message');
  if (loginForm) {
    loginForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const username = document.getElementById('usernameInput').value.trim().toLowerCase();
      const pin = document.getElementById('pinInput').value.trim();
      const foundUser = users.find(u => u.username.toLowerCase() === username && u.pin === pin);
      if (foundUser) {
        localStorage.setItem('user', JSON.stringify(foundUser));
        window.location.href = foundUser.role === 'admin' ? 'admin.html' : 'dashboard.html';
      } else {
        errorMessage.textContent = 'Invalid username or PIN';
      }
    });
  }

  // ----- Route guard -----
  const onDash = window.location.pathname.includes('dashboard.html');
  const onAdmin = window.location.pathname.includes('admin.html');

  if (onDash || onAdmin) {
    if (!user) { window.location.href = 'index.html'; return; }
    if (onAdmin && user.role !== 'admin') { window.location.href = 'dashboard.html'; return; }
  }

  // ===== Dashboard =====
  if (onDash) {
    document.getElementById('welcome-message').textContent =
      `Welcome, ${user.username.charAt(0).toUpperCase() + user.username.slice(1)}`;

    const partSelect = document.getElementById('partSelect');
    const actionSelect = document.getElementById('actionSelect');
    const notesInput = document.getElementById('notes');
    const logTableBody = document.getElementById('logTableBody');

    // NEW: explicit fields
    const expectedTimeEl = document.getElementById('expectedTime');
    const partNotesEl = document.getElementById('partNotes');

    // Populate dropdown
    if (Array.isArray(window.catalog)) {
      window.catalog.forEach(item => {
        if (item && item.partNumber) {
          const option = document.createElement('option');
          option.value = item.partNumber;
          option.textContent = `${item.partNumber} - ${item.name}`;
          partSelect.appendChild(option);
        }
      });
    }

    // Update info fields when part changes
    function updatePartInfo() {
      const selected = (window.catalog || []).find(i => i.partNumber === partSelect.value);
      if (selected) {
        if (expectedTimeEl) expectedTimeEl.textContent = `Expected Time: ${selected.hours || '--'} hours`;
        if (partNotesEl) partNotesEl.textContent = `Notes: ${selected.notes || '--'}`;
      } else {
        if (expectedTimeEl) expectedTimeEl.textContent = 'Expected Time: -- hours';
        if (partNotesEl) partNotesEl.textContent = 'Notes: --';
      }
    }
    partSelect.addEventListener('change', updatePartInfo);

    async function fetchLogs() {
      try {
        const res = await fetch(`${API_URL}/logs/${user.username}`);
        const data = await res.json();
        renderLogs(data);
        activeLogs.clear();
        data.forEach(log => { if (!log.endTime) activeLogs.add(log.partNumber); });
      } catch (err) {
        console.error('Failed to fetch logs:', err);
      }
    }

    function renderLogs(logs) {
      logTableBody.innerHTML = '';
      logs.forEach(log => {
        const row = document.createElement('tr');
        const duration = log.startTime
          ? calculateDuration(log.startTime, log.endTime, log.pauseStart, log.pauseTotal)
          : 'N/A';
        row.innerHTML = `
          <td>${log.partNumber}</td>
          <td>${log.action}</td>
          <td>${new Date(log.timestamp).toLocaleString()}</td>
          <td>${log.note || ''}</td>
          <td>${duration}</td>
        `;
        logTableBody.appendChild(row);
      });
    }

    document.getElementById('submitLog').addEventListener('click', async () => {
      const partNumber = partSelect.value;
      const action = actionSelect.value;
      const note = notesInput.value.trim();

      if (!partNumber || !action) {
        alert('Please select a part and action.');
        return;
      }

      const isStart = action === 'Start';
      const isActive = activeLogs.has(partNumber);

      if (isStart && isActive) {
        alert('You already have an active log for this part.');
        return;
      } else if (!isStart && !isActive) {
        alert('No active log for this part. Start a new one first.');
        return;
      }

      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: user.username, partNumber, action, note }),
        });
        if (res.ok) {
          notesInput.value = '';
          actionSelect.value = '';
          await fetchLogs();
        } else {
          alert('Failed to submit log.');
        }
      } catch (err) {
        console.error('Error submitting log:', err);
      }
    });

    // Kick things off
    updatePartInfo();
    updateTimer = setInterval(fetchLogs, 5000);
    fetchLogs();
  }

  // ===== Admin =====
  if (onAdmin) {
    const activityTableBody = document.getElementById('activityTableBody');
    const clearLogsButton = document.getElementById('clearAllLogs');

    async function fetchAllLogs() {
      try {
        const res = await fetch(`${API_URL}/admin/logs`);
        const logs = await res.json();
        activityTableBody.innerHTML = '';
        logs.forEach(log => {
          const row = document.createElement('tr');
          const duration = log.startTime && log.endTime
            ? calculateDuration(log.startTime, log.endTime, log.pauseStart, log.pauseTotal)
            : 'N/A';
          row.innerHTML = `
            <td>${log.username}</td>
            <td>${log.partNumber}</td>
            <td>${log.action}</td>
            <td>${log.note || ''}</td>
            <td>${duration}</td>
          `;
          activityTableBody.appendChild(row);
        });
      } catch (err) {
        console.error('Failed to load admin logs:', err);
      }
    }

    if (clearLogsButton) {
      clearLogsButton.addEventListener('click', async () => {
        if (!confirm('Clear ALL logs? This cannot be undone.')) return;
        try {
          const res = await fetch(`${API_URL}/admin/clear-logs`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' }
          });
          if (!res.ok) throw new Error(`Server error: ${res.status}`);
          const result = await res.json();
          if (result.success) {
            activityTableBody.innerHTML = '';
            alert('All logs cleared.');
          } else {
            alert('Failed to clear logs.');
          }
        } catch (err) {
          console.error('Error clearing logs:', err);
          alert('Error clearing logs. Check console for details.');
        }
      });
    }

    document.getElementById('backToDashboard').addEventListener('click', () => {
      window.location.href = 'dashboard.html';
    });

    updateTimer = setInterval(fetchAllLogs, 5000);
    fetchAllLogs();
  }

  // ----- Util -----
  function calculateDuration(start, end, pauseStart, pauseTotal) {
    if (!start) return 'N/A';
    const now = Date.now();
    let endTime = end || now;
    let duration = endTime - start - (pauseTotal || 0);
    if (pauseStart && !end) duration -= (now - pauseStart);
    if (duration < 0) duration = 0;
    const h = Math.floor(duration / 3600000);
    const m = Math.floor((duration % 3600000) / 60000);
    const s = Math.floor((duration % 60000) / 1000);
    return `${h}h ${m}m ${s}s`;
  }

  window.addEventListener('beforeunload', () => {
    if (updateTimer) clearInterval(updateTimer);
  });
});
