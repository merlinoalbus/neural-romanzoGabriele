import { Router } from 'express';
import { config } from '../config.js';
import { exportGraphSnapshot, importGraphSnapshot } from '../services/graphSnapshotService.js';

const router = Router();

function adminSecretFromHeader(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

router.use((req, res, next) => {
  if (!config.mcpSharedSecret.trim()) {
    res.status(503).json({ error: 'admin_secret_not_configured' });
    return;
  }
  const direct = adminSecretFromHeader(req.headers['x-admin-secret']);
  const auth = adminSecretFromHeader(req.headers.authorization);
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
  if (direct === config.mcpSharedSecret || bearer === config.mcpSharedSecret) {
    next();
    return;
  }
  res.status(401).json({ error: 'unauthorized' });
});

router.get('/export', async (_req, res) => {
  try {
    const snapshot = await exportGraphSnapshot();
    const stamp = snapshot.exportedAt.replace(/[:.]/g, '-');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="romanzo-gabriele-graph-${stamp}.json"`);
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/import/dry-run', async (req, res) => {
  try {
    const result = await importGraphSnapshot({
      snapshot: req.body?.snapshot,
      mode: req.body?.mode,
      dryRun: true,
    });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/import/commit', async (req, res) => {
  try {
    const result = await importGraphSnapshot({
      snapshot: req.body?.snapshot,
      mode: req.body?.mode,
      dryRun: false,
      confirmProjectId: req.body?.confirmProjectId,
    });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
