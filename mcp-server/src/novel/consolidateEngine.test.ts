import assert from 'node:assert/strict';
import test from 'node:test';
import { runConsolidation } from './consolidateEngine.js';

function makeNodeRecord(id: string, type: string, label: string, metadata = {}, createdAt = '2026-06-23T00:00:00.000Z') {
  return {
    get: (key: string) => {
      if (key === 'id') return id;
      if (key === 'type') return type;
      if (key === 'label') return label;
      if (key === 'content') return 'some content';
      if (key === 'metadata') return JSON.stringify(metadata);
      if (key === 'provenance') return '{}';
      if (key === 'createdAt') return createdAt;
      return null;
    },
  };
}

test('runConsolidation merges duplicate nodes based on normalized labels inside the project scope', async () => {
  const seenParams: Array<Record<string, unknown>> = [];
  const mockQueryRunner = async (cypher: string, params: Record<string, unknown>) => {
    seenParams.push(params);
    if (cypher.includes('RETURN count(n) as count')) return [{ get: () => 4 }];
    if (cypher.includes('RETURN count(r) as count')) return [{ get: () => 5 }];
    if (cypher.includes('MATCH (n:Entity {projectId: $projectId})')) {
      return [
        makeNodeRecord('char-1', 'character', 'Gabriele Rinaldi', {}, '2026-06-23T01:00:00Z'),
        makeNodeRecord('char-2', 'character', 'gabriele  rinaldi ', {}, '2026-06-23T02:00:00Z'),
        makeNodeRecord('fac-1', 'faction', 'Gilda dei Mercanti', {}, '2026-06-23T01:00:00Z'),
        makeNodeRecord('fac-2', 'faction', 'Gilda Dei Mercanti', {}, '2026-06-23T03:00:00Z'),
      ];
    }
    return [];
  };

  const report = await runConsolidation(mockQueryRunner as any);

  assert.ok(report.ok);
  assert.equal(report.mergedNodes.length, 2);
  assert.equal(report.mergedNodes.find((merge) => merge.target.type === 'character')?.target.id, 'char-1');
  assert.equal(report.mergedNodes.find((merge) => merge.target.type === 'faction')?.target.id, 'fac-1');
  assert.ok(seenParams.every((params) => params.projectId === 'romanzo-gabriele'));
  assert.ok(seenParams.some((params) => params.duplicateId === 'char-2'));
  assert.ok(seenParams.some((params) => params.duplicateId === 'fac-2'));
});

test('runConsolidation merges explicit duplicates driven by metadata', async () => {
  const mockQueryRunner = async (cypher: string, _params: Record<string, unknown>) => {
    if (cypher.includes('count(n)')) return [{ get: () => 2 }];
    if (cypher.includes('count(r)')) return [{ get: () => 0 }];
    if (cypher.includes('MATCH (n:Entity {projectId: $projectId})')) {
      return [
        makeNodeRecord('char-target', 'character', 'Gabriel'),
        makeNodeRecord('char-dup', 'character', 'Gabriele', { duplicateOf: 'char-target' }),
      ];
    }
    return [];
  };

  const report = await runConsolidation(mockQueryRunner as any);

  assert.ok(report.ok);
  assert.equal(report.mergedNodes.length, 1);
  assert.equal(report.mergedNodes[0].target.id, 'char-target');
  assert.equal(report.mergedNodes[0].merged.id, 'char-dup');
});

test('runConsolidation infers and deduplicates relationships through REL.kind queries', async () => {
  const seenCyphers: string[] = [];
  const inferenceRecord = {
    get: (key: string) => {
      const values: Record<string, string> = {
        fromId: 'char-1',
        fromType: 'character',
        fromLabel: 'Gabriele',
        toId: 'fac-1',
        toType: 'faction',
        toLabel: 'Legione Celeste',
      };
      return values[key] ?? null;
    },
  };
  const paddedDuplicateRecord = {
    get: (key: string) => {
      const values: Record<string, string> = {
        fromId: ' char-1 ',
        fromType: 'character',
        fromLabel: 'Gabriele',
        toId: ' fac-1 ',
        toType: 'faction',
        toLabel: 'Legione Celeste',
      };
      return values[key] ?? null;
    },
  };

  const mockQueryRunner = async (cypher: string, _params: Record<string, unknown>) => {
    seenCyphers.push(cypher);
    if (cypher.includes('count(n)')) return [{ get: () => 3 }];
    if (cypher.includes('count(r)')) return [{ get: () => 2 }];
    if (cypher.includes('MATCH (n:Entity {projectId: $projectId})')) {
      return [
        makeNodeRecord('char-1', 'character', 'Gabriele'),
        makeNodeRecord('fac-1', 'faction', 'Legione Celeste'),
      ];
    }
    if (cypher.includes("state.type IN ['knowledge_state', 'character_goal']")) return [inferenceRecord, inferenceRecord, paddedDuplicateRecord];
    return [];
  };

  const report = await runConsolidation(mockQueryRunner as any);

  assert.ok(report.ok);
  assert.equal(report.inferredEdges.length, 1);
  assert.equal(report.inferredEdges[0].from.id, 'char-1');
  assert.equal(report.inferredEdges[0].to.id, 'fac-1');
  assert.equal(report.inferredEdges[0].kind, 'ally_of');
  assert.ok(seenCyphers.some((cypher) => cypher.includes('[r1:REL]')));
  assert.ok(seenCyphers.every((cypher) => !cypher.includes(':Relationship')));
});

test('runConsolidation writes inferred edges as REL relationships only', async () => {
  const seenCyphers: string[] = [];
  const mockQueryRunner = async (cypher: string, _params: Record<string, unknown>) => {
    seenCyphers.push(cypher);
    if (cypher.includes('count(n)')) return [{ get: () => 2 }];
    if (cypher.includes('count(r)')) return [{ get: () => 1 }];
    if (cypher.includes('MATCH (n:Entity {projectId: $projectId})')) {
      return [
        makeNodeRecord('state-1', 'character_state', 'Gabriele fragile'),
        makeNodeRecord('state-2', 'character_state', 'Gabriele consapevole'),
      ];
    }
    if (cypher.includes("rule: 'state_precedes'")) return [];
    if (cypher.includes("type: 'character_state'") && cypher.includes("changes_state")) {
      return [{
        get: (key: string) => {
          const values: Record<string, string> = {
            fromId: 'state-1',
            fromType: 'character_state',
            fromLabel: 'Gabriele fragile',
            toId: 'state-2',
            toType: 'character_state',
            toLabel: 'Gabriele consapevole',
            characterLabel: 'Gabriele',
          };
          return values[key] ?? null;
        },
      }];
    }
    return [];
  };

  const report = await runConsolidation(mockQueryRunner as any);

  assert.equal(report.inferredEdges.length, 1);
  assert.ok(seenCyphers.some((cypher) => cypher.includes('MERGE (from)-[r:REL {kind: $kind}]->(to)')));
  assert.ok(seenCyphers.every((cypher) => !cypher.includes(':Relationship')));
});
