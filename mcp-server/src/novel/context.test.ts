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
    node('secret', 'Segreto di Lisa'),
    node('power', 'Dono della luce'),
    node('artifact', 'Occhiali'),
    node('world_rule', '4.3 Angeli'),
    node('note', 'Nota'),
  ]);
  assert.equal(groups.chapters.length, 1);
  assert.equal(groups.drafts.length, 0);
  assert.equal(groups.characters.length, 1);
  assert.equal(groups.secrets.length, 1);
  assert.equal(groups.powers.length, 1);
  assert.equal(groups.artifacts.length, 1);
  assert.equal(groups.worldRules.length, 1);
  assert.equal(groups.other.length, 1);
});

test('groupNarrativeContext excludes Bible technical nodes from editorial packets', () => {
  const groups = groupNarrativeContext([
    node('character', 'Lisa Martini'),
    node('bible_candidate', 'candidate-1'),
    node('bible_coverage_finding', 'edge-evidence-1'),
    node('bible_mapping_batch', 'batch-1'),
    node('bible_outline', 'bibbia-gabriele-2025'),
    node('bible_section', 'bibbia-gabriele-2025::3.2'),
    node('note', 'Nota narrativa non tipizzata'),
  ]);
  assert.equal(groups.characters.length, 1);
  assert.equal(groups.other.length, 1);
  assert.equal(groups.other[0]?.label, 'Nota narrativa non tipizzata');
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

test('auditChapterContent detects psychological trait contradictions', () => {
  const audit = auditChapterContent({
    chapterNumber: 2,
    content: 'Gabriele Rinaldi si alza e urla con rabbia.',
    chapter: node('chapter', 'Capitolo 2'),
    characters: [node('character', 'Gabriele Rinaldi')],
    styleRules: [node('style_rule', 'Regola Stile')],
    worldRules: [],
    themes: [],
    timelineEvents: [],
    characterTraits: [
      {
        id: 't-1',
        label: 'timido',
        content: 'Gabriele è molto timido.',
        charId: 'character:Gabriele Rinaldi',
        charLabel: 'Gabriele Rinaldi',
      }
    ],
  });

  const traitContr = audit.findings.find((f) => f.code === 'character_trait_contradiction');
  assert.ok(traitContr);
  assert.equal(traitContr.severity, 'warning');
  assert.ok(traitContr.message.includes('timido'));
  assert.ok(traitContr.message.includes('urla'));
});

test('auditChapterContent detects secret leaks', () => {
  const audit = auditChapterContent({
    chapterNumber: 2,
    content: 'Trevor Rossi parla della metamorfosi di Gabriele.',
    chapter: node('chapter', 'Capitolo 2'),
    characters: [node('character', 'Trevor Rossi')],
    styleRules: [node('style_rule', 'Regola Stile')],
    worldRules: [],
    themes: [],
    timelineEvents: [],
    characterSecrets: [
      {
        id: 's-1',
        label: 'metamorfosi segreta',
        content: 'La metamorfosi angelica di Gabriele.',
        charId: 'character:Trevor Rossi',
        charLabel: 'Trevor Rossi',
        relKind: 'does_not_know',
      }
    ],
  });

  const secretLeak = audit.findings.find((f) => f.code === 'secret_leak_detected');
  assert.ok(secretLeak);
  assert.equal(secretLeak.severity, 'warning');
  assert.ok(secretLeak.message.includes('Trevor Rossi'));
  assert.ok(secretLeak.message.includes('metamorfosi segreta'));
});

test('auditChapterContent references world rules in info findings', () => {
  const audit = auditChapterContent({
    chapterNumber: 2,
    content: 'Le piume magiche brillano nella stanza.',
    chapter: node('chapter', 'Capitolo 2'),
    characters: [],
    styleRules: [node('style_rule', 'Regola Stile')],
    worldRules: [
      node('world_rule', 'piume magiche', { content: 'Le piume degli angeli brillano al buio.' })
    ],
    themes: [],
    timelineEvents: [],
  });

  const ruleRef = audit.findings.find((f) => f.code === 'world_rule_reference');
  assert.ok(ruleRef);
  assert.equal(ruleRef.severity, 'info');
  assert.ok(ruleRef.message.includes('piume magiche'));
});

