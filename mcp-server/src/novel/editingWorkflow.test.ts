import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assembleRevisedBlocks,
  chapterBlockLabel,
  checkRewriteLength,
  makeFindingId,
  missingBlockNumbers,
  normalizeEditingStep,
  rewriteBlockLabel,
  splitChapterIntoBlocks,
} from './editingWorkflow.js';

test('splitChapterIntoBlocks creates bounded ordered blocks with phrases', () => {
  const content = Array.from({ length: 230 }, (_value, index) => `parola${index + 1}`).join(' ');
  const blocks = splitChapterIntoBlocks(content, 100);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].blockNumber, 1);
  assert.equal(blocks[0].wordCount, 100);
  assert.equal(blocks[2].wordCount, 30);
  assert.match(blocks[0].startPhrase, /parola1/);
});

test('editing workflow identifiers are stable', () => {
  assert.equal(normalizeEditingStep('continuity'), 'step1_continuity');
  assert.equal(normalizeEditingStep('3'), 'step3_rewrite');
  assert.equal(makeFindingId({ sessionId: 's1', step: 'step2_style', blockNumber: 4, index: 7 }), 'step2_style-B04-007');
  assert.equal(chapterBlockLabel('s1', 2), 's1::B002');
  assert.equal(rewriteBlockLabel('s1', 2), 's1::rewrite::B002');
});

test('checkRewriteLength enforces 85 to 140 percent range', () => {
  assert.equal(checkRewriteLength('a'.repeat(100), 'b'.repeat(85)).valid, true);
  assert.equal(checkRewriteLength('a'.repeat(100), 'b'.repeat(140)).valid, true);
  assert.equal(checkRewriteLength('a'.repeat(100), 'b'.repeat(84)).valid, false);
  assert.equal(checkRewriteLength('a'.repeat(100), 'b'.repeat(141)).valid, false);
});

test('assembleRevisedBlocks sorts blocks and rejects gaps', () => {
  assert.equal(assembleRevisedBlocks([{ blockNumber: 2, text: 'Due' }, { blockNumber: 1, text: 'Uno' }]), 'Uno\n\nDue');
  assert.deepEqual(missingBlockNumbers([{ blockNumber: 1, text: 'Uno' }, { blockNumber: 3, text: 'Tre' }]), [2]);
  assert.throws(() => assembleRevisedBlocks([{ blockNumber: 1, text: 'Uno' }, { blockNumber: 3, text: 'Tre' }]), /missing_rewrite_blocks/);
});
