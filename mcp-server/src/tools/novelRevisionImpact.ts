import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as kg from '../graph/neo4jStore.js';
import { hasPolarityConflict } from '../novel/bibleDiscrepancy.js';
import { CHAPTER_SECTION_ROLES, resolveChapterSectionLabel } from '../novel/domain.js';
import { chunkArray } from '../services/embeddingService.js';
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
// Below this cosine similarity between a fact's OLD and NEW content, the meaning has shifted
// enough to warrant a human read even when hasPolarityConflict (lexical, dictionary-based) does
// not fire — a rewording can contradict the original fact without using any of the polarity
// dictionary's phrases. This is a "review recommended" signal, not a contradiction claim: low
// embedding similarity does not reliably indicate truth-value opposition, only substantial
// semantic drift.
const SEMANTIC_MEANING_SHIFT_THRESHOLD = 0.7;

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
        'Read-only: for each canonical fact a chapter revision changes, walks the graph 1-2 hops to surface nodes that plausibly assumed the OLD version, and flags direct polarity conflicts (e.g. "sa" vs "non sa"). When embeddings are configured, also compares the OLD and NEW content of the changed fact itself by meaning (not just the lexical dictionary) and flags a substantial semantic shift as a review signal — distinct from directPolarityConflict, since low embedding similarity means "reread this," not "this is a contradiction." Never rewrites anything — only produces a report for explicit confirmation before the revision session closes. Required on the Revision path, not applicable to a fresh chapter with no prior canonical version.',
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
          semanticMeaningShift: z.object({
            similarity: z.number(),
            reviewRecommended: z.boolean(),
          }).optional(),
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
        // Each changed fact is scanned independently (graph walk + embeds): process them with
        // bounded concurrency instead of strictly one at a time. Output order matches input.
        const processFact = async (fact: z.infer<typeof changedFactInputZ>) => {
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

          // OLD vs NEW meaning shift: both raw contents in ONE batched provider call (two texts,
          // one HTTP request) instead of two sequential calls.
          let oldContentVector: number[] | null = null;
          let semanticMeaningShift: { similarity: number; reviewRecommended: boolean } | undefined;
          if (semantic && oldContent.trim()) {
            try {
              if (fact.newContent.trim() && semantic.embedTexts) {
                const [oldVector, newVector] = await semantic.embedTexts([oldContent, fact.newContent]);
                oldContentVector = oldVector;
                const similarity = cosineSimilarity(oldVector, newVector);
                semanticMeaningShift = { similarity, reviewRecommended: similarity < SEMANTIC_MEANING_SHIFT_THRESHOLD };
              } else {
                oldContentVector = await semantic.embedText(oldContent);
                if (fact.newContent.trim()) {
                  const newContentVector = await semantic.embedText(fact.newContent);
                  const similarity = cosineSimilarity(oldContentVector, newContentVector);
                  semanticMeaningShift = { similarity, reviewRecommended: similarity < SEMANTIC_MEANING_SHIFT_THRESHOLD };
                }
              }
            } catch {
              oldContentVector = null;
              semanticMeaningShift = undefined;
            }
          }

          // Neighbor affinity: canonical nodes are already embedded in Neo4j (composite
          // type+label+content text), so compare stored vector against stored vector and skip
          // the provider entirely. The changed node still holds its OLD content here (the scan
          // runs before the in-place update), so its stored vector represents the old fact.
          // Only neighbors without a stored vector fall back to fresh embeds, batched in one
          // provider call against the raw old content.
          const semanticCheckNodes = neighborNodes.slice(0, MAX_SEMANTIC_CHECKS_PER_FACT);
          const storedVectors = semantic
            ? await kg.getNodeEmbeddings([changedNode.id, ...semanticCheckNodes.map((node) => node.id)]).catch(() => new Map<string, kg.StoredNodeEmbedding>())
            : new Map<string, kg.StoredNodeEmbedding>();
          const changedStored = storedVectors.get(changedNode.id);

          const likelyByNodeId = new Map<string, boolean>();
          const fallbackNodes: kg.GraphNode[] = [];
          for (const neighborNode of semanticCheckNodes) {
            if (!semantic || !neighborNode.content.trim()) continue;
            const neighborStored = storedVectors.get(neighborNode.id);
            // Same-model guard: mid-backfill after a model switch, stored vectors from different
            // models live in incompatible spaces — comparing them would produce garbage scores.
            if (changedStored && neighborStored && changedStored.model === neighborStored.model) {
              likelyByNodeId.set(neighborNode.id, cosineSimilarity(changedStored.vector, neighborStored.vector) >= SEMANTIC_LIKELY_AFFECTED_THRESHOLD);
            } else if (oldContentVector) {
              fallbackNodes.push(neighborNode);
            }
          }
          if (semantic && oldContentVector && fallbackNodes.length) {
            try {
              const fallbackVectors = semantic.embedTexts
                ? await semantic.embedTexts(fallbackNodes.map((node) => node.content))
                : await (async () => {
                    const vectors: number[][] = [];
                    for (const node of fallbackNodes) vectors.push(await semantic.embedText(node.content));
                    return vectors;
                  })();
              for (const [index, node] of fallbackNodes.entries()) {
                likelyByNodeId.set(node.id, cosineSimilarity(oldContentVector, fallbackVectors[index]) >= SEMANTIC_LIKELY_AFFECTED_THRESHOLD);
              }
            } catch {
              // leave likelyAssumesOldFact undefined for these neighbors
            }
          }

          const potentiallyImpactedNodes = neighborNodes.map((neighborNode) => ({
            node: neighborNode,
            relationKinds: [...(relationKindsByNodeId.get(neighborNode.id) ?? [])],
            likelyAssumesOldFact: likelyByNodeId.get(neighborNode.id),
          }));

          return { changedNode, oldContent, newContent: fact.newContent, directPolarityConflict, semanticMeaningShift, potentiallyImpactedNodes };
        };

        // Concurrency 5: enough to overlap graph walks and embeds without flooding the GPU
        // queue (OLLAMA_NUM_PARALLEL) or the Neo4j connection pool.
        const impacts: Array<Awaited<ReturnType<typeof processFact>>> = [];
        for (const factChunk of chunkArray(changedFacts, 5)) {
          impacts.push(...(await Promise.all(factChunk.map(processFact))));
        }

        const requiresConfirmation = impacts.some(
          (impact) =>
            impact.directPolarityConflict ||
            impact.semanticMeaningShift?.reviewRecommended ||
            impact.potentiallyImpactedNodes.some((entry) => entry.likelyAssumesOldFact) ||
            impact.potentiallyImpactedNodes.length > 0,
        );

        return toolStructured({ ok: true, impacts, requiresConfirmation });
      } catch (err) {
        return toolError('NOVEL_SCAN_REVISION_IMPACT_FAILED', `novel_scan_revision_impact failed: ${String(err)}`, { chapterNumber, role });
      }
    },
  );
}
