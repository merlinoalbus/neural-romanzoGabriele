import { Router } from 'express';
import * as kg from '../services/neo4jReadService.js';

const router = Router();

router.get('/stats', async (_req, res) => {
  try {
    res.json(await kg.stats());
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
    res.json({ nodes: await kg.search(q, { type, limit }) });
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
    res.json(await kg.neighbors(id, { depth }));
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
    const node = id ? await kg.getNodeById(id) : await kg.getNodeByTypeLabel(type!, label!);
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
    res.json({ nodes: await kg.listNodes({ type, limit }) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
