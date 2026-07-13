import { Router } from 'express';
import * as kg from '../services/neo4jReadService.js';

const router = Router();

// Read-only aggregation endpoints tailored to the narrative "cockpit" views. The sole frontend
// mutation surface is isolated in routes/editor.ts and proxied to the MCP working-draft service;
// canonical graph writes remain unavailable here.

router.get('/chapters', async (_req, res) => {
  try {
    res.json({ chapters: await kg.listChapters() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/chapter', async (req, res) => {
  try {
    const id = String(req.query.id ?? '').trim();
    if (!id) {
      res.status(400).json({ error: 'query parameter id is required' });
      return;
    }
    res.json(await kg.chapterPacket(id));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/entity', async (req, res) => {
  try {
    const id = String(req.query.id ?? '').trim();
    if (!id) {
      res.status(400).json({ error: 'query parameter id is required' });
      return;
    }
    res.json(await kg.entityPacket(id));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/timeline', async (_req, res) => {
  try {
    res.json({ entries: await kg.timeline() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/health', async (_req, res) => {
  try {
    res.json(await kg.health());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
