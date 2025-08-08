document.addEventListener('DOMContentLoaded', () => {
  const user = JSON.parse(localStorage.getItem('user'));
  const API_URL = 'https://czm-wireshop.onrender.com/api/jobs';
  let activeLogs = new Set(); // Track active partNumbers to prevent duplicates
  let updateTimer;

  // Login Logic
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

  // Protect Pages
  if (window.location.pathname.includes('dashboard.html') || window.location.pathname.includes('admin.html')) {
    if (!user) {
      window.location.href = 'index.html';
      return;
    }
    if (window.location.pathname.includes('admin.html') && user.role !== 'admin') {
      window.location.href = 'dashboard.html'; // Redirect assemblers away from admin
      return;
    }
  }

  // Dashboard Page Logic
  if (window.location.pathname.includes('dashboard.html')) {
    document.getElementById('welcome-message').textContent =
      `Welcome, ${user.username.charAt(0).toUpperCase() + user.username.slice(1)}`;

    const partSelect = document.getElementById('partSelect');
    const partInfo = document.getElementById('partInfo');
    const actionSelect = document.getElementById('actionSelect');
    const notesInput = document.getElementById('notes');
    const logTableBody = document.getElementById('logTableBody');

    catalog.forEach(item => {
      if (item.partNumber) {
        const option = document.createElement('option');
        option.value = item.partNumber;
        option.textContent = `${item.partNumber} - ${item.name}`;
        partSelect.appendChild(option);
      }
    });

    partSelect.addEventListener('change', () => {
      const selected = catalog.find(item => item.partNumber === partSelect.value);
      if (selected) {
        partInfo.textContent = `Expected Time: ${selected.hours} hours\nNotes: ${selected.notes}`;
      } else {
        partInfo.textContent = 'Expected Time: -- hours\nNotes: --';
      }
    });

    async function fetchLogs() {
      try {
        const res = await fetch(`${API_URL}/logs/${user.username}`);
        const data = await res.json();
        renderLogs(data);
        // Update active logs set based on fetched data
        activeLogs.clear();
        data.forEach(log => {
          if (!log.endTime) {
            activeLogs.add(log.partNumber);
          }
        });
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
          actionSelect.value = '-- Select Action --';
          fetchLogs(); // Refresh logs
        } else {
          alert('Failed to submit log.');
        }
      } catch (err) {
        console.error('Error submitting log:', err);
      }
    });

    // Auto-update logs every 5 seconds
    updateTimer = setInterval(fetchLogs, 5000);
    fetchLogs(); // Initial fetch
  }

  // Admin Page Logic
  if (window.location.pathname.includes('admin.html')) {
    const activityTableBody = document.getElementById('activityTableBody');
    const clearLogsButton = document.getElementById('clearAllLogs');

    async function fetchAllLogs() {
      try {
        const res = await fetch(`${API_URL}/admin/logs`);
        const logs = await res.json();
        activityTableBody.innerHTML = ''; // Clear any static rows
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
        console.log('Clear logs button clicked');
        if (confirm('Are you sure you want to clear all logs? This cannot be undone.')) {
          try {
            console.log('Sending DELETE request to:', `${API_URL}/admin/clear-logs`);
            const res = await fetch(`${API_URL}/admin/clear-logs`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' }
            });

            console.log('Response status:', res.status);
            if (!res.ok) {
              const raw = await res.text();
              console.error('Server responded with:', raw);
              throw new Error(`Server error: ${res.status}`);
            }

            const result = await res.json();
            console.log('Response data:', result);
            if (result.success) {
              activityTableBody.innerHTML = ''; // Clear the table
              alert('All logs cleared successfully.');
            } else {
              alert('Failed to clear logs.');
            }
          } catch (err) {
            console.error('Error clearing logs:', err.message || err);
            alert('Error clearing logs. Check console for details.');
          }
        }
      });
    } else {
      console.error('Clear logs button (clearAllLogs) not found in the DOM');
    }

    function calculateDuration(start, end, pauseStart, pauseTotal) {
      if (!start) return 'N/A';
      const now = Date.now();
      let endTime = end || now;
      let duration = endTime - start - (pauseTotal || 0);
      if (pauseStart && !end) {
        duration -= (now - pauseStart); // Subtract current pause time
      }
      if (duration < 0) duration = 0;
      const h = Math.floor(duration / 3600000);
      const m = Math.floor((duration % 3600000) / 60000);
      const s = Math.floor((duration % 60000) / 1000);
      return `${h}h ${m}m ${s}s`;
    }

    document.getElementById('backToDashboard').addEventListener('click', () => {
      window.location.href = 'dashboard.html';
    });

    // Auto-update admin logs every 5 seconds
    updateTimer = setInterval(fetchAllLogs, 5000);
    fetchAllLogs(); // Initial fetch
  }

  // Cleanup timer on page unload
  window.addEventListener('beforeunload', () => {
    if (updateTimer) clearInterval(updateTimer);
  });
});