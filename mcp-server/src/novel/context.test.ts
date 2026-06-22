import assert from 'node:assert/strict';
import test from 'node:test';
import { auditChapterContent, composeRecallQuery, detectMentionedCharacters, groupNarrativeContext } from './context.js';
import type { GraphNode } from '../graph/neo4jStore.js';

function node(type: string, label: string, metadata: Record<string, unknown> = {}): GraphNode {
  return {
    id: `${type}:${label}`,
    type,
    label,
    content: '',
    metadata,
    provenance: {},
    createdAt: '',
    updatedAt: '',
  };
}

test('composeRecallQuery builds stable narrative queries', () => {
  assert.equal(
    composeRecallQuery({ task: 'revisione', chapterNumber: 12, query: 'piume', characters: ['Gabriele', 'Lisa'] }),
    'revisione piume Capitolo 12 Gabriele Lisa',
  );
});

test('groupNarrativeContext separates domain nodes and hides drafts by default', () => {
  const groups = groupNarrativeContext([
    node('chapter', 'Capitolo 1'),
    node('chapter_draft', 'Capitolo 1 draft a'),
    node('character', 'Lisa Martini'),
    node('world_rule', '4.3 Angeli'),
    node('note', 'Nota'),
  ]);
  assert.equal(groups.chapters.length, 1);
  assert.equal(groups.drafts.length, 0);
  assert.equal(groups.characters.length, 1);
  assert.equal(groups.worldRules.length, 1);
  assert.equal(groups.other.length, 1);
});

test('detectMentionedCharacters uses aliases and parenthetical names', () => {
  const characters = [
    node('character', 'Gabriele Rinaldi (Gabriel)'),
    node('character', 'Trevor Rossi', { aliases: ['SpeedyGonzy'] }),
  ];
  const detected = detectMentionedCharacters('Gabriel guarda SpeedyGonzy in silenzio.', characters);
  assert.deepEqual(detected.map((entry) => entry.label), ['Gabriele Rinaldi (Gabriel)', 'Trevor Rossi']);
});

test('auditChapterContent reports missing context without mutating state', () => {
  const audit = auditChapterContent({
    chapterNumber: 2,
    content: 'Lisa entra in corridoio.',
    chapter: null,
    characters: [node('character', 'Lisa Martini')],
    styleRules: [],
    worldRules: [],
    themes: [],
    timelineEvents: [],
  });
  assert.ok(audit.findings.some((finding) => finding.code === 'missing_chapter_outline'));
  assert.ok(audit.findings.some((finding) => finding.code === 'missing_style_rules'));
  assert.deepEqual(audit.detectedCharacters.map((entry) => entry.label), ['Lisa Martini']);
});
