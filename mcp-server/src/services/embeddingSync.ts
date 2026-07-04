import * as kg from '../graph/neo4jStore.js';
import type { SemanticDiscrepancyOptions } from '../novel/bibleDiscrepancy.js';
import {
  embedTextCached,
  embedTexts,
  embeddingRuntimeStatus,
  embeddingText,
  getEmbeddingSettings,
  type EmbeddingSettings,
} from './embeddingService.js';

export type EmbedNodeStatus = 'embedded' | 'skipped_up_to_date' | 'skipped_not_configured' | 'skipped_not_found' | 'skipped_error';

export interface EmbedNodeResult {
  nodeId: string;
  status: EmbedNodeStatus;
  error?: string;
}

/**
 * Core batch embedder. Never throws: any failure (network, provider, configuration, Neo4j)
 * degrades to `skipped_*` results instead of aborting the caller — a broken provider must never
 * block the canonical write that already happened. Nodes left without an embedding are naturally
 * picked up by the next `kg_backfill_embeddings({missingOnly:true})` pass.
 *
 * Performance shape:
 * - one Neo4j round-trip to load the nodes' embedding state;
 * - nodes whose stored `embeddingTextHash` (and model) already match are skipped without
 *   touching the provider at all;
 * - the remaining texts go to the provider in array batches (one HTTP request per
 *   `settings.batchSize` texts, GPU-batched by Ollama);
 * - one UNWIND write per batch persists all vectors together.
 */
async function embedNodesBatch(nodeIds: string[], settings: EmbeddingSettings): Promise<EmbedNodeResult[]> {
  const uniqueIds = [...new Set(nodeIds.filter(Boolean))];
  if (!uniqueIds.length) return [];

  const status = embeddingRuntimeStatus(settings);
  if (!status.configured) return uniqueIds.map((nodeId) => ({ nodeId, status: 'skipped_not_configured' as const }));

  let candidates: kg.EmbeddingCandidateWithState[];
  try {
    candidates = await kg.getEmbeddingCandidatesByIds(uniqueIds);
  } catch (err) {
    return uniqueIds.map((nodeId) => ({ nodeId, status: 'skipped_error' as const, error: String(err) }));
  }

  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const resultById = new Map<string, EmbedNodeResult>();
  const pending: Array<{ nodeId: string; text: string; textHash: string }> = [];

  for (const nodeId of uniqueIds) {
    const candidate = byId.get(nodeId);
    if (!candidate) {
      resultById.set(nodeId, { nodeId, status: 'skipped_not_found' });
      continue;
    }
    const text = embeddingText(candidate);
    const textHash = kg.embeddingTextHash(text);
    if (candidate.hasEmbedding && candidate.embeddingTextHash === textHash && candidate.embeddingModel === settings.model) {
      resultById.set(nodeId, { nodeId, status: 'skipped_up_to_date' });
      continue;
    }
    pending.push({ nodeId, text, textHash });
  }

  if (pending.length) {
    try {
      const vectors = await embedTexts(pending.map((item) => item.text), settings);
      // Idempotent and memoized: makes the semantic gate self-sufficient from the very first
      // commit after activation, without paying an index check per node.
      try {
        await kg.createEmbeddingIndex(vectors[0].length);
      } catch {
        // best-effort
      }
      await kg.writeNodeEmbeddings(
        pending.map((item, index) => ({ nodeId: item.nodeId, vector: vectors[index], textHash: item.textHash })),
        { provider: settings.provider, model: settings.model, dimensions: vectors[0].length },
      );
      for (const item of pending) resultById.set(item.nodeId, { nodeId: item.nodeId, status: 'embedded' });
    } catch (err) {
      for (const item of pending) {
        if (!resultById.has(item.nodeId)) {
          resultById.set(item.nodeId, { nodeId: item.nodeId, status: 'skipped_error', error: String(err) });
        }
      }
    }
  }

  return uniqueIds.map((nodeId) => resultById.get(nodeId) ?? { nodeId, status: 'skipped_error', error: 'unknown' });
}

/** Embeds and stores the vector for a single node; see `embedNodesBatch` for semantics. */
export async function embedNode(nodeId: string, settings: EmbeddingSettings = getEmbeddingSettings()): Promise<EmbedNodeResult> {
  const results = await embedNodesBatch([nodeId], settings);
  return results[0] ?? { nodeId, status: 'skipped_error', error: 'unknown' };
}

/**
 * Embeds a batch of nodes right after a canonical commit so the vector index never drifts out
 * of sync with the graph between manual backfills. Never throws.
 */
export async function embedNodesInline(nodeIds: string[]): Promise<EmbedNodeResult[]> {
  return embedNodesBatch(nodeIds, getEmbeddingSettings());
}

/**
 * Vector-search seeds for hybrid recall: embeds the query (LRU-cached) and returns the closest
 * canonical nodes, so kg_recall / novel_recall_context find meaning matches even when the
 * wording differs from the canon. Returns [] whenever embeddings are not configured, the index
 * is not ready, or anything fails — recall then behaves exactly as the lexical-only version.
 */
export async function semanticRecallSeeds(query: string, opts: { limit?: number } = {}): Promise<kg.GraphNode[]> {
  const settings = getEmbeddingSettings();
  if (!query.trim() || !embeddingRuntimeStatus(settings).configured) return [];
  try {
    const readiness = await kg.semanticSearchReadiness();
    if (!readiness.ready) return [];
    const vector = await embedTextCached(query, settings);
    const results = await kg.semanticSearch(vector, { limit: opts.limit ?? 5 });
    return results.map((result) => result.node);
  } catch {
    return [];
  }
}

/**
 * The semantic half of the hybrid gate (bibleDiscrepancy.ts's buildCanonDiscrepancyReport):
 * returns wired-up embed/search functions when embeddings are configured, or `undefined` when
 * they are not — callers pass this straight through and the discrepancy engine falls back to
 * lexical-only checking, exactly as it did before embeddings existed.
 *
 * `embedText` is LRU-cached (repeated gate checks on the same candidate text skip the GPU) and
 * `embedTexts` batches many texts into single provider requests.
 */
export function semanticDiscrepancyOptionsIfConfigured(settings: EmbeddingSettings = getEmbeddingSettings()): SemanticDiscrepancyOptions | undefined {
  const status = embeddingRuntimeStatus(settings);
  if (!status.configured) return undefined;
  return {
    embedText: (text: string) => embedTextCached(text, settings),
    embedTexts: (texts: string[]) => embedTexts(texts, settings),
    semanticSearch: (vector: number[], opts: { type?: string; limit?: number }) => kg.semanticSearch(vector, opts),
  };
}
