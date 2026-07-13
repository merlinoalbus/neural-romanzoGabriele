import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { parseMarkdownDraft, serializeMarkdownDraft } from './markdownDraft';

const encodedDraft = process.env.LIVE_DRAFT_BASE64;

it.skipIf(!encodedDraft)('round-trips the complete live draft structurally without saving it', () => {
  const source = Buffer.from(encodedDraft ?? '', 'base64').toString('utf8');
  const parsed = parseMarkdownDraft(source);
  const normalized = serializeMarkdownDraft(parsed);
  const reparsed = parseMarkdownDraft(normalized);
  expect(reparsed.eq(parsed)).toBe(true);
  console.log(JSON.stringify({
    sourceChars: source.length,
    sourceHash: crypto.createHash('sha256').update(source).digest('hex'),
    normalizedChars: normalized.length,
    normalizedHash: crypto.createHash('sha256').update(normalized).digest('hex'),
    normalizedDiffers: normalized !== source,
  }));
});
