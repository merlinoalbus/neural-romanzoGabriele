import crypto from 'node:crypto';
import { normalizeChapterLabel, type EditingStepId } from './domain.js';

export interface ChapterBlock {
  blockNumber: number;
  label: string;
  text: string;
  wordCount: number;
  charCount: number;
  startPhrase: string;
  endPhrase: string;
}

export interface RewriteLengthCheck {
  originalChars: number;
  revisedChars: number;
  ratio: number;
  minAllowed: number;
  maxAllowed: number;
  valid: boolean;
}

export interface RevisedBlock {
  blockNumber: number;
  text: string;
}

export function stableHash(input: string, length = 16): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, length);
}

export function editingSessionLabel(input: { chapterNumber: number; sessionId?: string }): string {
  return `Editing ${normalizeChapterLabel(input.chapterNumber)} ${input.sessionId?.trim() || 'session'}`;
}

export function normalizeEditingStep(raw: string): EditingStepId {
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'step1' || value === 'continuity') return 'step1_continuity';
  if (value === '2' || value === 'step2' || value === 'style') return 'step2_style';
  if (value === '3' || value === 'step3' || value === 'rewrite') return 'step3_rewrite';
  if (value === '4' || value === 'step4' || value === 'seams') return 'step4_seams';
  if (value === '5' || value === 'step5' || value === 'typesetting') return 'step5_typesetting';
  if (value === '6' || value === 'step6' || value === 'art') return 'step6_art';
  if (
    value === 'step1_continuity' ||
    value === 'step2_style' ||
    value === 'step3_rewrite' ||
    value === 'step4_seams' ||
    value === 'step5_typesetting' ||
    value === 'step6_art'
  ) {
    return value;
  }
  throw new Error(`invalid_editing_step: ${raw}`);
}

function wordsWithPositions(text: string): Array<{ word: string; start: number; end: number }> {
  const matches: Array<{ word: string; start: number; end: number }> = [];
  for (const match of text.matchAll(/\S+/g)) {
    matches.push({ word: match[0], start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  return matches;
}

function phrase(text: string, fromEnd = false): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const sentenceParts = normalized.match(/[^.!?]+[.!?]?/g)?.map((part) => part.trim()).filter(Boolean) ?? [normalized];
  const selected = fromEnd ? sentenceParts[sentenceParts.length - 1] : sentenceParts[0];
  return selected.length > 160 ? `${selected.slice(0, 157).trim()}...` : selected;
}

export function splitChapterIntoBlocks(content: string, maxWords = 600): ChapterBlock[] {
  const text = content.replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  const words = wordsWithPositions(text);
  if (!words.length) return [];
  const blockSize = Math.max(100, Math.min(Math.trunc(maxWords), 1000));
  const blocks: ChapterBlock[] = [];
  for (let startWord = 0; startWord < words.length; startWord += blockSize) {
    const endWord = Math.min(startWord + blockSize, words.length) - 1;
    const start = words[startWord].start;
    const end = words[endWord].end;
    const blockText = text.slice(start, end).trim();
    blocks.push({
      blockNumber: blocks.length + 1,
      label: `Blocco ${blocks.length + 1}`,
      text: blockText,
      wordCount: endWord - startWord + 1,
      charCount: blockText.length,
      startPhrase: phrase(blockText),
      endPhrase: phrase(blockText, true),
    });
  }
  return blocks;
}

export function makeFindingId(input: { sessionId: string; step: EditingStepId; blockNumber?: number; index: number }): string {
  const block = input.blockNumber ? `B${String(input.blockNumber).padStart(2, '0')}` : 'GLOBAL';
  return `${input.step}-${block}-${String(input.index).padStart(3, '0')}`;
}

export function chapterBlockLabel(sessionId: string, blockNumber: number): string {
  return `${sessionId}::B${String(blockNumber).padStart(3, '0')}`;
}

export function rewriteBlockLabel(sessionId: string, blockNumber: number): string {
  return `${sessionId}::rewrite::B${String(blockNumber).padStart(3, '0')}`;
}

export function checkRewriteLength(original: string, revised: string): RewriteLengthCheck {
  const originalChars = original.length;
  const revisedChars = revised.length;
  const ratio = originalChars > 0 ? revisedChars / originalChars : 0;
  const minAllowed = originalChars * 0.85;
  const maxAllowed = originalChars * 1.4;
  return {
    originalChars,
    revisedChars,
    ratio,
    minAllowed,
    maxAllowed,
    valid: originalChars > 0 && revisedChars >= minAllowed && revisedChars <= maxAllowed,
  };
}

export function findingSummary(findings: Array<{ severity?: string; category?: string }>): Record<string, number> {
  const summary: Record<string, number> = { total: findings.length };
  for (const finding of findings) {
    const severity = finding.severity ?? 'unknown';
    const category = finding.category ?? 'unknown';
    summary[`severity:${severity}`] = (summary[`severity:${severity}`] ?? 0) + 1;
    summary[`category:${category}`] = (summary[`category:${category}`] ?? 0) + 1;
  }
  return summary;
}

export function missingBlockNumbers(blocks: RevisedBlock[]): number[] {
  if (!blocks.length) return [];
  const max = Math.max(...blocks.map((block) => block.blockNumber));
  const present = new Set(blocks.map((block) => block.blockNumber));
  const missing: number[] = [];
  for (let blockNumber = 1; blockNumber <= max; blockNumber++) {
    if (!present.has(blockNumber)) missing.push(blockNumber);
  }
  return missing;
}

export function assembleRevisedBlocks(blocks: RevisedBlock[]): string {
  const missing = missingBlockNumbers(blocks);
  if (missing.length) throw new Error(`missing_rewrite_blocks: ${missing.join(', ')}`);
  return [...blocks]
    .sort((a, b) => a.blockNumber - b.blockNumber)
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n');
}
