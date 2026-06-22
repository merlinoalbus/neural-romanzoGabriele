import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOutlinePlan, parseOutlineEntries } from './outline.js';

const sampleOutline = [
  '2.3\tTemi Centrali\t21',
  '2.3.1\tTrasformazione e Identita:\t21',
  '3\tDossier dei Personaggi\t32',
  '3.1\tGabriele Rinaldi (Gabriel)\t32',
  "3.1.11\tLinguaggio e 'Voce'\t37",
  '3.7\tPersonaggi Secondari\t64',
  '3.7.1\tLaura Mancini\t64',
  '4.3\tElementi Sovrannaturali\t83',
  '4.3.4\tRegole Celesti\t84',
  '5.1\tParte 1: Un Brutto Anatroccolo Con Un Segreto\t87',
  '5.1.1\tPrologo: La Promessa della Cioccolata Calda\t87',
  '5.1.2\tCapitolo 1: Vigilia di Scuola\t87',
  '5.4.10\tEpilogo: La Promessa della Cioccolata Calda\t102',
  '5.5.6\tStile di Prosa\t104',
].join('\n');

test('parseOutlineEntries classifies narrative outline entries', () => {
  const entries = parseOutlineEntries(sampleOutline);
  assert.equal(entries.find((entry) => entry.number === '2.3.1')?.nodeType, 'theme');
  assert.equal(entries.find((entry) => entry.number === '3.1')?.nodeType, 'character');
  assert.equal(entries.find((entry) => entry.number === '3.7.1')?.nodeType, 'character');
  assert.equal(entries.find((entry) => entry.number === '4.3.4')?.nodeType, 'world_rule');
  assert.equal(entries.find((entry) => entry.number === '5.1.2')?.nodeType, 'chapter');
  assert.equal(entries.find((entry) => entry.number === '5.1.2')?.label, 'Capitolo 1');
  assert.equal(entries.find((entry) => entry.number === '5.1.1')?.label, 'Prologo');
  assert.equal(entries.find((entry) => entry.number === '5.4.10')?.label, 'Epilogo');
  assert.equal(entries.find((entry) => entry.number === '5.5.6')?.nodeType, 'style_rule');
});

test('buildOutlinePlan creates root, nodes and structural edges', () => {
  const plan = buildOutlinePlan({ sourceId: 'indice-bibbia', content: sampleOutline });
  assert.equal(plan.root.type, 'bible_outline');
  assert.equal(plan.nodes.length, 14);
  assert.equal(plan.nodes.find((node) => node.key === '5.1.2')?.metadata.chapterNumber, 1);
  assert.ok(plan.edges.some((edge) => edge.fromKey === '5.1.2' && edge.toKey === '5.1' && edge.kind === 'part_of'));
  assert.ok(plan.edges.some((edge) => edge.fromKey === '5.1.1' && edge.toKey === '5.1.2' && edge.kind === 'precedes'));
});

test('parseOutlineEntries ignores duplicate outline numbers', () => {
  const entries = parseOutlineEntries(['2\tLogline\t16', '2\tLogline duplicata\t16'].join('\n'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'Logline');
});
