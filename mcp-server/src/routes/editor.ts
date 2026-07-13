import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import {
  ChapterFinalizationInProgressError,
  DraftVersionConflictError,
  getSessionWorkingDraft,
  updateSessionWorkingDraft,
  WorkingDraftNotFoundError,
} from '../novel/workingDraftService.js';

const router = Router();

function authorized(req: Request): boolean {
  if (!config.mcpSharedSecret) return config.appEnv !== 'production';
  const received = String(req.header('X-Source-Secret') ?? '');
  const expectedBuffer = Buffer.from(config.mcpSharedSecret);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

router.use((req, res, next) => {
  if (!authorized(req)) {
    res.status(401).json({ error: { code: 'EDITOR_UNAUTHORIZED', message: 'Credenziali interne non valide.' } });
    return;
  }
  next();
});

function chapterNumberFrom(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof DraftVersionConflictError) {
    res.status(409).json({
      error: {
        code: err.code,
        message: err.message,
        details: {
          current: err.current,
          expectedContentHash: err.expectedContentHash,
          expectedRevision: err.expectedRevision,
        },
      },
    });
    return;
  }
  if (err instanceof ChapterFinalizationInProgressError) {
    res.status(409).json({
      error: {
        code: err.code,
        message: err.message,
        details: {
          chapterNumber: err.chapterNumber,
          finalizingSessionId: err.finalizingSessionId,
        },
      },
    });
    return;
  }
  if (err instanceof WorkingDraftNotFoundError) {
    res.status(404).json({ error: { code: err.code, message: err.message } });
    return;
  }
  const message = String(err);
  const badRequest = message.includes('editing_session_') || message.includes('invalid_working_draft');
  res.status(badRequest ? 400 : 500).json({
    error: { code: badRequest ? 'DRAFT_BAD_INPUT' : 'DRAFT_UPDATE_FAILED', message },
  });
}

router.get('/drafts/:chapterNumber', async (req, res) => {
  const chapterNumber = chapterNumberFrom(req.params.chapterNumber);
  const sessionId = String(req.query.sessionId ?? '').trim();
  if (!chapterNumber || !sessionId) {
    res.status(400).json({ error: { code: 'DRAFT_BAD_INPUT', message: 'chapterNumber and sessionId are required.' } });
    return;
  }
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await getSessionWorkingDraft(sessionId, chapterNumber));
  } catch (err) {
    sendError(res, err);
  }
});

router.put('/drafts/:chapterNumber', async (req, res) => {
  const chapterNumber = chapterNumberFrom(req.params.chapterNumber);
  const sessionId = String(req.body?.sessionId ?? '').trim();
  const content = req.body?.content;
  const expectedContentHash = String(req.body?.expectedContentHash ?? '');
  const expectedRevision = Number(req.body?.expectedRevision);
  if (
    !chapterNumber || !sessionId || typeof content !== 'string' || !content.trim()
    || !/^[a-f0-9]{64}$/i.test(expectedContentHash)
    || !Number.isInteger(expectedRevision) || expectedRevision < 1
    || Object.prototype.hasOwnProperty.call(req.body ?? {}, 'force')
  ) {
    res.status(400).json({
      error: {
        code: 'DRAFT_BAD_INPUT',
        message: 'sessionId, content, expectedContentHash and expectedRevision are required; force bypass is not supported.',
      },
    });
    return;
  }
  try {
    const result = await updateSessionWorkingDraft({
      sessionId,
      chapterNumber,
      content,
      expectedContentHash,
      expectedRevision,
      author: 'user',
      clientMutationId: typeof req.body?.clientMutationId === 'string' ? req.body.clientMutationId.slice(0, 200) : undefined,
      changeSummary: typeof req.body?.changeSummary === 'string' ? req.body.changeSummary.slice(0, 2000) : undefined,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
