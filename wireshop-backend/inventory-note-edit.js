const dbDefault = require('./db');

module.exports = function attachInventoryNoteEdit(app, opts = {}) {
  const db = opts.db || dbDefault;

  function getUser(req) {
    return String(req.headers['x-user'] || '').trim().toLowerCase();
  }

  function requireUser(req, res, next) {
    const user = getUser(req);
    if (!user) return res.status(401).json({ error: 'x-user required' });
    req.user = user;
    next();
  }

  // Note-only edit available to all logged-in techs/admins.
  // Delta/quantity values are intentionally not writable here.
  app.put('/api/inventory-log/:id/note', requireUser, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

    const note = String(req.body?.note || '');

    db.run(
      `UPDATE inventory_log SET note = ? WHERE id = ?`,
      [note, id],
      function (err) {
        if (err) return res.status(500).json({ error: 'db error' });
        if (this.changes === 0) return res.status(404).json({ error: 'not found' });
        res.json({ ok: true, id, note });
      }
    );
  });
};
