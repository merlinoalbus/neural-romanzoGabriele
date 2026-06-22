import { Router } from 'express';
import { saveDocumentSource } from '../storage/documentStore.js';

const router = Router();

router.post('/source', async (req, res) => {
  try {
    const sourceId = String(req.body?.sourceId ?? '').trim();
    if (!sourceId) {
      res.status(400).json({ error: 'sourceId is required' });
      return;
    }
    res.json(await saveDocumentSource({ sourceId, content: req.body?.content, metadata: req.body?.metadata }));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
