import { Router } from 'express';
import * as kg from '../services/neo4jReadService.js';

const router = Router();

function includeInternal(req: { query: Record<string, unknown> }): boolean {
  const value = String(req.query.includeInternal ?? req.query.view ?? '').toLowerCase();
  return value === 'true' || value === 'all';
}

router.get('/stats', async (req, res) => {
  try {
    res.json(await kg.stats({ includeInternal: includeInternal(req) }));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (!q) {
      res.json({ nodes: [] });
      return;
    }
    const type = req.query.type ? String(req.query.type) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json({ nodes: await kg.search(q, { type, limit, includeInternal: includeInternal(req) }) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/neighbors', async (req, res) => {
  try {
    const id = String(req.query.id ?? '').trim();
    if (!id) {
      res.status(400).json({ error: 'query parameter id is required' });
      return;
    }
    const depth = req.query.depth ? Number(req.query.depth) : undefined;
    res.json(await kg.neighbors(id, { depth, includeInternal: includeInternal(req) }));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/node', async (req, res) => {
  try {
    const id = req.query.id ? String(req.query.id) : undefined;
    const type = req.query.type ? String(req.query.type) : undefined;
    const label = req.query.label ? String(req.query.label) : undefined;
    if (!id && !(type && label)) {
      res.status(400).json({ error: 'query parameter id, or type+label, is required' });
      return;
    }
    const opts = { includeInternal: includeInternal(req) };
    const node = id ? await kg.getNodeById(id, opts) : await kg.getNodeByTypeLabel(type!, label!, opts);
    res.json({ node });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/documents', async (req, res) => {
  try {
    const sourceType = req.query.sourceType ? String(req.query.sourceType) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json({ documents: await kg.listDocuments({ sourceType, limit }) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/nodes', async (req, res) => {
  try {
    const type = req.query.type ? String(req.query.type) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json({ nodes: await kg.listNodes({ type, limit, includeInternal: includeInternal(req) }) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
