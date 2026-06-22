import { Router } from 'express';
import { exportGraphSnapshot, importGraphSnapshot } from '../services/graphSnapshotService.js';

const router = Router();

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
