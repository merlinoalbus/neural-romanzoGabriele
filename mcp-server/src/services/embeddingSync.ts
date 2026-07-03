import * as kg from '../graph/neo4jStore.js';
import type { SemanticDiscrepancyOptions } from '../novel/bibleDiscrepancy.js';
import { embedText, embeddingRuntimeStatus, embeddingText, getEmbeddingSettings, type EmbeddingSettings } from './embeddingService.js';

export type EmbedNodeStatus = 'embedded' | 'skipped_not_configured' | 'skipped_not_found' | 'skipped_error';

export interface EmbedNodeResult {
  nodeId: string;
  status: EmbedNodeStatus;
  error?: string;
}

/**
 * Embeds and stores the vector for a single node, never throwing: any failure (network,
 * provider, configuration) degrades to a `skipped_*` result instead of aborting the caller.
 * A node that stays without an embedding is naturally picked up by the next
 * `kg_backfill_embeddings({missingOnly:true})` pass — no separate "pending" bookkeeping needed.
 */
export async function embedNode(nodeId: string, settings: EmbeddingSettings = getEmbeddingSettings()): Promise<EmbedNodeResult> {
  const status = embeddingRuntimeStatus(settings);
  if (!status.configured) return { nodeId, status: 'skipped_not_configured' };

  const node = await kg.getNodeById(nodeId);
  if (!node) return { nodeId, status: 'skipped_not_found' };

  try {
    const text = embeddingText(node);
    const vector = await embedText(text, settings);
    await kg.writeNodeEmbedding(nodeId, vector, {
      provider: settings.provider,
      model: settings.model,
      dimensions: vector.length,
      textHash: kg.embeddingTextHash(text),
    });
    return { nodeId, status: 'embedded' };
  } catch (err) {
    return { nodeId, status: 'skipped_error', error: String(err) };
  }
}

/**
 * Embeds a batch of nodes sequentially (the embeddings provider has no batch endpoint here),
 * called inline right after a canonical commit so the vector index never drifts out of sync
 * with the graph between manual backfills. Never throws — a broken provider must never block
 * the canonical write that already happened.
 */
export async function embedNodesInline(nodeIds: string[]): Promise<EmbedNodeResult[]> {
  const uniqueIds = [...new Set(nodeIds.filter(Boolean))];
  if (!uniqueIds.length) return [];
  const settings = getEmbeddingSettings();
  const status = embeddingRuntimeStatus(settings);
  if (!status.configured) return uniqueIds.map((nodeId) => ({ nodeId, status: 'skipped_not_configured' as const }));

  const results: EmbedNodeResult[] = [];
  for (const nodeId of uniqueIds) {
    results.push(await embedNode(nodeId, settings));
  }
  return results;
}

/**
 * The semantic half of the hybrid gate (bibleDiscrepancy.ts's buildCanonDiscrepancyReport):
 * returns wired-up embed/search functions when embeddings are configured, or `undefined` when
 * they are not — callers pass this straight through and the discrepancy engine falls back to
 * lexical-only checking, exactly as it did before embeddings existed.
 */
export function semanticDiscrepancyOptionsIfConfigured(settings: EmbeddingSettings = getEmbeddingSettings()): SemanticDiscrepancyOptions | undefined {
  const status = embeddingRuntimeStatus(settings);
  if (!status.configured) return undefined;
  return {
    embedText: (text: string) => embedText(text, settings),
    semanticSearch: (vector: number[], opts: { type?: string; limit?: number }) => kg.semanticSearch(vector, opts),
  };
}
