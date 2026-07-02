import { Router } from 'express';
import * as kg from '../services/neo4jReadService.js';

const router = Router();

// Read-only aggregation endpoints tailored to the narrative "cockpit" views.
// The frontend never writes to the graph; writes go only through the MCP server.

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

export default router;
