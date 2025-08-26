<script>
(function () {
  // auth gate (same as your other pages)
  const user = (() => { try { return JSON.parse(localStorage.getItem('user')||'{}'); } catch { return {}; } })();
  if (!user || !user.username) { location.href = '/index.html'; return; }

  // inject compact styles for the buttons (keeps your existing theme)
  const s = document.createElement('style');
  s.textContent = `
    .brand-actions .navbtn{display:inline-block;background:var(--red);color:#fff;padding:8px 12px;border-radius:9px;text-decoration:none;font-weight:700;margin-left:8px}
    .brand-actions .navbtn:hover{filter:brightness(.92)}
    .brand-actions .navbtn.active{outline:2px solid #fff;outline-offset:2px}
    .brand-actions button.navbtn{border:0;cursor:pointer}
  `;
  document.head.appendChild(s);

  // render the bar
  const bar = document.createElement('div');
  bar.className = 'brand-bar';
  bar.innerHTML = `
    <div class="brand-inner">
      <a class="brand-logo" href="/dashboard.html">
        <img src="/czm-logo.png" alt="CZM">
        <h1 class="brand-title">CZM • Inventory</h1>
      </a>
      <div class="brand-actions">
        <a class="navbtn" href="/dashboard.html">Dashboard</a>
        <a class="navbtn" href="/assignments.html">Assignments</a>
        <a class="navbtn" href="/inventory">Inventory</a>
        <a class="navbtn" href="/admin.html">Live View</a>
        <button id="logoutBtn" class="navbtn">Logout</button>
      </div>
    </div>
  `;
  document.body.prepend(bar);

  // highlight current page; treat /inventory-list.html and /inventory as the same
  const path = location.pathname.replace(/\/+$/,'').toLowerCase();
  document.querySelectorAll('.brand-actions .navbtn[href]').forEach(a => {
    const href = a.getAttribute('href').toLowerCase();
    const normalized = href.replace(/\/+$/,'');
    const isInv = normalized === '/inventory' && (path === '/inventory' || path === '/inventory-list.html');
    if (normalized === path || isInv) a.classList.add('active');
  });

  // logout
  bar.querySelector('#logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('user');
    location.href = '/index.html';
  });
})();
</script>
