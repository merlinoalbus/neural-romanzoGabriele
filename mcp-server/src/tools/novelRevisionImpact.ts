import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as kg from '../graph/neo4jStore.js';
import { hasPolarityConflict } from '../novel/bibleDiscrepancy.js';
import { CHAPTER_SECTION_ROLES, resolveChapterSectionLabel } from '../novel/domain.js';
import { semanticDiscrepancyOptionsIfConfigured } from '../services/embeddingSync.js';
import { errorObj, toolError, toolStructured } from './responseHelpers.js';

/**
 * When a revision changes a canonical fact that other nodes were built on top of, the
 * consequence must be surfaced for review — never silently propagated. This is the "+ tutti gli
 * impatti che ne consegue" half of the update-in-place requirement: update the fact in place
 * (that part already happens via kg_upsert_node / novel_commit_chapter_candidates), then scan
 * what else in the graph plausibly assumed the OLD version of that fact.
 */

const MAX_NEIGHBORS_PER_FACT = 30;
const MAX_SEMANTIC_CHECKS_PER_FACT = 15;
const SEMANTIC_LIKELY_AFFECTED_THRESHOLD = 0.75;

const IMPACT_RELATION_KINDS = [
  'precedes',
  'applies_to',
  'about',
  'has_theme',
  'occurs_in',
  'occurs_at',
  'derived_from',
  'part_of',
  'knows',
  'does_not_know',
  'learns',
  'sets_up',
  'pays_off',
  'foreshadows',
];

const jsonObj = z.record(z.string(), z.unknown());

const nodeZ = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  content: z.string(),
  metadata: jsonObj,
  provenance: jsonObj,
  createdAt: z.string(),
  updatedAt: z.string(),
});

const changedFactInputZ = z.object({
  nodeId: z.string().optional(),
  type: z.string().optional(),
  label: z.string().optional(),
  newContent: z.string(),
});

async function resolveChangedFactNode(fact: z.infer<typeof changedFactInputZ>): Promise<kg.GraphNode> {
  if (fact.nodeId) {
    const node = await kg.getNodeById(fact.nodeId);
    if (!node) throw new Error(`changed_fact_node_not_found: ${fact.nodeId}`);
    return node;
  }
  if (fact.type && fact.label) {
    const node = await kg.getNodeByTypeLabel(fact.type, fact.label);
    if (!node) throw new Error(`changed_fact_node_not_found: ${fact.type}/${fact.label}`);
    return node;
  }
  throw new Error('changed_fact_missing_identifier: provide nodeId, or type and label');
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function registerNovelRevisionImpactTools(server: McpServer): void {
  server.registerTool(
    'novel_scan_revision_impact',
    {
      title: 'Novel scan revision impact',
      description:
        'Read-only: for each canonical fact a chapter revision changes, walks the graph 1-2 hops to surface nodes that plausibly assumed the OLD version, and flags direct polarity conflicts (e.g. "sa" vs "non sa"). Never rewrites anything — only produces a report for explicit confirmation before the revision session closes. Required on the Revision path, not applicable to a fresh chapter with no prior canonical version.',
      inputSchema: {
        chapterNumber: z.number().int().positive().optional(),
        role: z.enum(CHAPTER_SECTION_ROLES).optional(),
        changedFacts: z.array(changedFactInputZ).min(1).max(50),
      },
      outputSchema: {
        ok: z.boolean(),
        impacts: z.array(z.object({
          changedNode: nodeZ,
          oldContent: z.string(),
          newContent: z.string(),
          directPolarityConflict: z.boolean(),
          potentiallyImpactedNodes: z.array(z.object({
            node: nodeZ,
            relationKinds: z.array(z.string()),
            likelyAssumesOldFact: z.boolean().optional(),
          })),
        })).optional(),
        requiresConfirmation: z.boolean().optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel scan revision impact', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ chapterNumber, role, changedFacts }) => {
      try {
        if (chapterNumber === undefined && !role) {
          return toolError('NOVEL_SCAN_REVISION_IMPACT_BAD_INPUT', 'Provide chapterNumber (numbered chapter) or role (prologo/epilogo).');
        }
        const chapterLabel = resolveChapterSectionLabel({ chapterNumber, role });
        const chapter = await kg.getNodeByTypeLabel('chapter', chapterLabel);
        if (!chapter) return toolError('NOVEL_SCAN_REVISION_IMPACT_CHAPTER_NOT_FOUND', `Chapter not found: ${chapterLabel}`, { chapterNumber, role });

        const semantic = semanticDiscrepancyOptionsIfConfigured();
        const impacts = [];
        for (const fact of changedFacts) {
          const changedNode = await resolveChangedFactNode(fact);
          const oldContent = changedNode.content;
          const directPolarityConflict = hasPolarityConflict(oldContent, fact.newContent);

          const expanded = await kg.neighbors(changedNode.id, { depth: 2, kinds: IMPACT_RELATION_KINDS });
          const relationKindsByNodeId = new Map<string, Set<string>>();
          for (const edge of expanded.edges) {
            for (const nodeId of [edge.fromId, edge.toId]) {
              if (nodeId === changedNode.id) continue;
              const set = relationKindsByNodeId.get(nodeId) ?? new Set<string>();
              set.add(edge.kind);
              relationKindsByNodeId.set(nodeId, set);
            }
          }
          const neighborNodes = expanded.nodes.filter((node) => node.id !== changedNode.id).slice(0, MAX_NEIGHBORS_PER_FACT);

          let oldContentVector: number[] | null = null;
          if (semantic && oldContent.trim()) {
            try {
              oldContentVector = await semantic.embedText(oldContent);
            } catch {
              oldContentVector = null;
            }
          }

          const potentiallyImpactedNodes = [];
          for (const [index, neighborNode] of neighborNodes.entries()) {
            let likelyAssumesOldFact: boolean | undefined;
            if (oldContentVector && index < MAX_SEMANTIC_CHECKS_PER_FACT && neighborNode.content.trim()) {
              try {
                const neighborVector = await semantic!.embedText(neighborNode.content);
                likelyAssumesOldFact = cosineSimilarity(oldContentVector, neighborVector) >= SEMANTIC_LIKELY_AFFECTED_THRESHOLD;
              } catch {
                likelyAssumesOldFact = undefined;
              }
            }
            potentiallyImpactedNodes.push({
              node: neighborNode,
              relationKinds: [...(relationKindsByNodeId.get(neighborNode.id) ?? [])],
              likelyAssumesOldFact,
            });
          }

          impacts.push({ changedNode, oldContent, newContent: fact.newContent, directPolarityConflict, potentiallyImpactedNodes });
        }

        const requiresConfirmation = impacts.some(
          (impact) => impact.directPolarityConflict || impact.potentiallyImpactedNodes.some((entry) => entry.likelyAssumesOldFact) || impact.potentiallyImpactedNodes.length > 0,
        );

        return toolStructured({ ok: true, impacts, requiresConfirmation });
      } catch (err) {
        return toolError('NOVEL_SCAN_REVISION_IMPACT_FAILED', `novel_scan_revision_impact failed: ${String(err)}`, { chapterNumber, role });
      }
    },
  );
}
