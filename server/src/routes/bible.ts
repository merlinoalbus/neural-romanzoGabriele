import { Router } from 'express';
import * as kg from '../services/neo4jReadService.js';

const router = Router();

router.get('/progress', async (_req, res) => {
  try {
    res.json(await kg.bibleProgress());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/embedding-status', async (_req, res) => {
  try {
    res.json(await kg.embeddingIndexStatus());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
