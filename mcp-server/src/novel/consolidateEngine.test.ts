import assert from 'node:assert/strict';
import test from 'node:test';
import { runConsolidation } from './consolidateEngine.js';

test('runConsolidation merges duplicate nodes based on normalized labels', async () => {
  const makeNodeRecord = (id: string, type: string, label: string, metadata = {}, createdAt = '2026-06-23T00:00:00.000Z') => ({
    get: (key: string) => {
      if (key === 'id') return id;
      if (key === 'type') return type;
      if (key === 'label') return label;
      if (key === 'content') return 'some content';
      if (key === 'metadata') return JSON.stringify(metadata);
      if (key === 'provenance') return '{}';
      if (key === 'createdAt') return createdAt;
      return null;
    }
  });

  const mockQueryRunner = async (cypher: string, _params: Record<string, any>) => {
    if (cypher.includes('MATCH (n:Entity) RETURN count(n)')) {
      return [{ get: () => 4 }];
    }
    if (cypher.includes('MATCH ()-[r]->() RETURN count(r)')) {
      return [{ get: () => 5 }];
    }
    if (cypher.includes('MATCH (n:Entity) RETURN n.id as id')) {
      return [
        makeNodeRecord('char-1', 'character', 'Gabriele Rinaldi', {}, '2026-06-23T01:00:00Z'),
        makeNodeRecord('char-2', 'character', 'gabriele  rinaldi ', {}, '2026-06-23T02:00:00Z'), // Duplicato
        makeNodeRecord('fac-1', 'faction', 'Gilda dei Mercanti', {}, '2026-06-23T01:00:00Z'),
        makeNodeRecord('fac-2', 'faction', 'Gilda Dei Mercanti', {}, '2026-06-23T03:00:00Z'), // Duplicato
      ];
    }
    return [];
  };

  const report = await runConsolidation(true, mockQueryRunner as any);
  
  assert.ok(report.ok);
  assert.equal(report.mergedNodes.length, 2);
  
  const merge1 = report.mergedNodes.find((m) => m.target.type === 'character');
  assert.ok(merge1);
  assert.equal(merge1.target.id, 'char-1');
  assert.equal(merge1.merged.id, 'char-2');

  const merge2 = report.mergedNodes.find((m) => m.target.type === 'faction');
  assert.ok(merge2);
  assert.equal(merge2.target.id, 'fac-1');
  assert.equal(merge2.merged.id, 'fac-2');
});

test('runConsolidation merges explicit duplicates driven by metadata', async () => {
  const makeNodeRecord = (id: string, type: string, label: string, metadata = {}) => ({
    get: (key: string) => {
      if (key === 'id') return id;
      if (key === 'type') return type;
      if (key === 'label') return label;
      if (key === 'content') return '';
      if (key === 'metadata') return JSON.stringify(metadata);
      if (key === 'provenance') return '{}';
      if (key === 'createdAt') return '2026-06-23T00:00:00Z';
      return null;
    }
  });

  const mockQueryRunner = async (cypher: string, _params: Record<string, any>) => {
    if (cypher.includes('count(n)')) return [{ get: () => 2 }];
    if (cypher.includes('count(r)')) return [{ get: () => 0 }];
    if (cypher.includes('MATCH (n:Entity) RETURN n.id as id')) {
      return [
        makeNodeRecord('char-target', 'character', 'Gabriel'),
        makeNodeRecord('char-dup', 'character', 'Gabriele', { duplicateOf: 'char-target' }),
      ];
    }
    return [];
  };

  const report = await runConsolidation(true, mockQueryRunner as any);
  
  assert.ok(report.ok);
  assert.equal(report.mergedNodes.length, 1);
  assert.equal(report.mergedNodes[0].target.id, 'char-target');
  assert.equal(report.mergedNodes[0].merged.id, 'char-dup');
});

test('runConsolidation infers relationships based on logic rules', async () => {
  const makeNodeRecord = (id: string, type: string, label: string) => ({
    get: (key: string) => {
      if (key === 'id') return id;
      if (key === 'type') return type;
      if (key === 'label') return label;
      if (key === 'content') return '';
      if (key === 'metadata') return '{}';
      if (key === 'provenance') return '{}';
      if (key === 'createdAt') return '2026-06-23T00:00:00Z';
      return null;
    }
  });

  const mockQueryRunner = async (cypher: string, _params: Record<string, any>) => {
    if (cypher.includes('count(n)')) return [{ get: () => 3 }];
    if (cypher.includes('count(r)')) return [{ get: () => 2 }];
    if (cypher.includes('MATCH (n:Entity) RETURN n.id as id')) {
      return [
        makeNodeRecord('char-1', 'character', 'Gabriele'),
        makeNodeRecord('fac-1', 'faction', 'Legione Celeste'),
      ];
    }
    // Regola 1: Character - State - Faction -> inferisce character - faction
    if (cypher.includes('MATCH (c:Entity {type: \'character\'})-[r1]-(state:Entity)-[r2]-(f:Entity {type: \'faction\'})')) {
      return [{
        get: (key: string) => {
          if (key === 'charId') return 'char-1';
          if (key === 'charLabel') return 'Gabriele';
          if (key === 'charType') return 'character';
          if (key === 'facId') return 'fac-1';
          if (key === 'facLabel') return 'Legione Celeste';
          if (key === 'facType') return 'faction';
          return null;
        }
      }];
    }
    return [];
  };

  const report = await runConsolidation(true, mockQueryRunner as any);
  
  assert.ok(report.ok);
  assert.equal(report.inferredEdges.length, 1);
  assert.equal(report.inferredEdges[0].from.id, 'char-1');
  assert.equal(report.inferredEdges[0].to.id, 'fac-1');
  assert.equal(report.inferredEdges[0].kind, 'ally_of');
});
