/**
 * GET/PUT /api/account-settings: balance y % de riesgo de la cuenta (SQLite, ver db/account-settings-store).
 * Públicos como /api/mt5/settings (los usa la pantalla Configuración en móvil y escritorio).
 */
function registerAccountSettingsRoutes(app, store) {
  app.get('/api/account-settings', async (_req, res) => {
    try {
      res.json(await store.get());
    } catch (err) {
      console.error('[account-settings] get:', err);
      res.status(500).json({ error: 'No se pudo leer el balance de la cuenta' });
    }
  });

  app.put('/api/account-settings', async (req, res) => {
    try {
      res.json(await store.update(req.body));
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: err.message, errors: err.errors });
      console.error('[account-settings] put:', err);
      res.status(500).json({ error: 'No se pudo guardar el balance de la cuenta' });
    }
  });
}

module.exports = { registerAccountSettingsRoutes };
