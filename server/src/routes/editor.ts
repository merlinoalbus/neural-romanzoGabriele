import { Router } from 'express';
import { requestMcpEditor } from '../services/mcpEditorClient.js';

const router = Router();

function chapterNumberFrom(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

router.get('/drafts/:chapterNumber', async (req, res) => {
  const chapterNumber = chapterNumberFrom(req.params.chapterNumber);
  const sessionId = String(req.query.sessionId ?? '').trim();
  if (!chapterNumber || !sessionId) {
    res.status(400).json({ error: { code: 'DRAFT_BAD_INPUT', message: 'chapterNumber and sessionId are required.' } });
    return;
  }
  try {
    const query = new URLSearchParams({ sessionId });
    const result = await requestMcpEditor('GET', `/internal/editor/drafts/${chapterNumber}?${query.toString()}`);
    res.setHeader('Cache-Control', 'no-store');
    res.status(result.status).json(result.payload);
  } catch (err) {
    res.status(502).json({ error: { code: 'MCP_EDITOR_UNAVAILABLE', message: String(err) } });
  }
});

router.put('/drafts/:chapterNumber', async (req, res) => {
  const chapterNumber = chapterNumberFrom(req.params.chapterNumber);
  if (!chapterNumber) {
    res.status(400).json({ error: { code: 'DRAFT_BAD_INPUT', message: 'A positive chapterNumber is required.' } });
    return;
  }
  try {
    const result = await requestMcpEditor('PUT', `/internal/editor/drafts/${chapterNumber}`, req.body);
    res.setHeader('Cache-Control', 'no-store');
    res.status(result.status).json(result.payload);
  } catch (err) {
    res.status(502).json({ error: { code: 'MCP_EDITOR_UNAVAILABLE', message: String(err) } });
  }
});

export default router;
