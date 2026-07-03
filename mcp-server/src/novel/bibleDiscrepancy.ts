import type { GraphEdge, GraphNode } from '../graph/neo4jStore.js';
import type { ContentCandidate, ContentCandidateEndpoint } from './bibleCandidates.js';

export type BibleDiscrepancySeverity = 'info' | 'warning' | 'error';

export interface BibleDiscrepancy {
  candidateId?: string;
  relatedCandidateId?: string;
  code: string;
  severity: BibleDiscrepancySeverity;
  message: string;
  blocking: boolean;
  authorized?: boolean;
  requiredResolution?: string;
  existingNodeId?: string;
  existingNodeType?: string;
  existingNodeLabel?: string;
  existingEdgeId?: string;
  existingRelationKind?: string;
  relationKind?: string;
  from?: ContentCandidateEndpoint;
  to?: ContentCandidateEndpoint;
}

export interface BibleDiscrepancyReport {
  discrepancies: BibleDiscrepancy[];
  hasBlockingDiscrepancies: boolean;
  summary: {
    checkedCandidates: number;
    checkedCanonicalNodes: number;
    checkedCanonicalEdges: number;
    errors: number;
    warnings: number;
    info: number;
    blocking: number;
  };
}

type PlannedNode = {
  candidate: ContentCandidate;
  type: string;
  label: string;
  content: string;
  normalizedLabel: string;
};

type PlannedEdge = {
  candidate: ContentCandidate;
  kind: string;
  fromKey: string;
  toKey: string;
  from: ContentCandidateEndpoint;
  to: ContentCandidateEndpoint;
};

const STOPWORDS = new Set([
  'a',
  'ad',
  'al',
  'alla',
  'che',
  'con',
  'da',
  'del',
  'della',
  'di',
  'e',
  'gli',
  'il',
  'in',
  'la',
  'le',
  'lo',
  'ma',
  'nel',
  'non',
  'o',
  'per',
  'si',
  'un',
  'una',
]);

const OPPOSING_KIND_PAIRS: Array<[string, string]> = [
  ['knows', 'does_not_know'],
  ['permits', 'forbids'],
  ['trusts', 'distrusts'],
  ['reveals', 'conceals'],
  ['supports', 'contradicts'],
  ['defines', 'contradicts'],
  ['requires', 'forbids'],
  ['learns', 'does_not_know'],
];

const SYMMETRIC_KINDS = new Set(['ally_of', 'enemy_of', 'family_of', 'contradicts', 'contrasts', 'mirrors']);

const POLARITY_PHRASES: Array<{ key: string; positive: string[]; negative: string[] }> = [
  { key: 'knowledge', positive: [' sa ', ' conosce ', ' consapevole '], negative: [' non sa ', ' non conosce ', ' ignora '] },
  { key: 'permission', positive: [' puo ', ' puo farlo ', ' permette ', ' consente '], negative: [' non puo ', ' vieta ', ' vietato ', ' proibisce ', ' impossibile '] },
  { key: 'revelation', positive: [' rivela ', ' svela ', ' scopre '], negative: [' nasconde ', ' cela ', ' occulta ', ' segreto '] },
  { key: 'trust', positive: [' si fida ', ' fiducia '], negative: [' diffida ', ' non si fida ', ' sfiducia '] },
];

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('it-IT')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function paddedNormalized(value: unknown): string {
  const normalized = normalizeText(value);
  return normalized ? ` ${normalized} ` : '';
}

function tokens(value: unknown): string[] {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function tokenOverlap(a: unknown, b: unknown): number {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection++;
  }
  return intersection / Math.min(left.size, right.size);
}

function labelSimilarity(a: string, b: string): number {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.9;
  return tokenOverlap(left, right);
}

function contentOf(candidate: ContentCandidate): string {
  return [candidate.label, candidate.content, candidate.rationale].filter(Boolean).join(' ');
}

function endpointKey(endpoint: ContentCandidateEndpoint): string {
  return `${endpoint.type}::${normalizeText(endpoint.label)}`;
}

function nodeEndpointKey(node: Pick<GraphNode, 'type' | 'label'>): string {
  return `${node.type}::${normalizeText(node.label)}`;
}

function hasResolution(candidate: ContentCandidate, resolution: string): boolean {
  const value = candidate.metadata?.discrepancyResolution;
  if (value === resolution) return true;
  return Array.isArray(value) && value.includes(resolution);
}

function polarityProfile(value: unknown): Set<string> {
  const text = paddedNormalized(value);
  const profile = new Set<string>();
  for (const entry of POLARITY_PHRASES) {
    if (entry.positive.some((phrase) => text.includes(phrase))) profile.add(`${entry.key}:positive`);
    if (entry.negative.some((phrase) => text.includes(phrase))) profile.add(`${entry.key}:negative`);
  }
  return profile;
}

function hasGenericNegation(value: unknown): boolean {
  const text = paddedNormalized(value);
  return [' non ', ' mai ', ' nessun ', ' nessuna ', ' senza ', ' impossibile ', ' vietato ', ' vietata '].some((phrase) => text.includes(phrase));
}

/**
 * Exported for reuse by the revision-impact scan (novelRevisionImpact.ts): detects whether two
 * pieces of text assert opposite things about the same kind of fact (knowledge, permission,
 * revelation, trust), or diverge in generic negation while still overlapping in topic.
 */
export function hasPolarityConflict(a: unknown, b: unknown): boolean {
  const left = polarityProfile(a);
  const right = polarityProfile(b);
  for (const entry of POLARITY_PHRASES) {
    if (left.has(`${entry.key}:positive`) && right.has(`${entry.key}:negative`)) return true;
    if (left.has(`${entry.key}:negative`) && right.has(`${entry.key}:positive`)) return true;
  }
  return hasGenericNegation(a) !== hasGenericNegation(b) && tokenOverlap(a, b) >= 0.45;
}

function opposingKinds(a: string, b: string): boolean {
  if (a === b) return false;
  return OPPOSING_KIND_PAIRS.some(([left, right]) => (a === left && b === right) || (a === right && b === left));
}

function sameEdgeScope(a: { fromKey: string; toKey: string; kind: string }, b: { fromKey: string; toKey: string; kind: string }): boolean {
  if (a.fromKey === b.fromKey && a.toKey === b.toKey) return true;
  return (SYMMETRIC_KINDS.has(a.kind) || SYMMETRIC_KINDS.has(b.kind)) && a.fromKey === b.toKey && a.toKey === b.fromKey;
}

function addDiscrepancy(
  discrepancies: BibleDiscrepancy[],
  discrepancy: Omit<BibleDiscrepancy, 'blocking' | 'authorized'>,
  candidate?: ContentCandidate,
): void {
  const authorized = discrepancy.requiredResolution ? Boolean(candidate && hasResolution(candidate, discrepancy.requiredResolution)) : false;
  const blocking = discrepancy.severity === 'error' && !authorized;
  discrepancies.push({ ...discrepancy, authorized: authorized || undefined, blocking });
}

function plannedNodes(candidates: ContentCandidate[]): PlannedNode[] {
  return candidates
    .filter((candidate) => candidate.candidateKind === 'node' && candidate.targetType && candidate.label)
    .map((candidate) => ({
      candidate,
      type: candidate.targetType!,
      label: candidate.label!,
      content: candidate.content ?? '',
      normalizedLabel: normalizeText(candidate.label),
    }));
}

function plannedEdges(candidates: ContentCandidate[]): PlannedEdge[] {
  return candidates
    .filter((candidate) => candidate.candidateKind === 'edge' && candidate.relationKind && candidate.from && candidate.to)
    .map((candidate) => ({
      candidate,
      kind: candidate.relationKind!,
      from: candidate.from!,
      to: candidate.to!,
      fromKey: endpointKey(candidate.from!),
      toKey: endpointKey(candidate.to!),
    }));
}

function compareCandidateNodeWithCanonical(discrepancies: BibleDiscrepancy[], planned: PlannedNode, existing: GraphNode): void {
  if (planned.type !== existing.type) return;
  const normalizedExistingLabel = normalizeText(existing.label);
  const similarity = labelSimilarity(planned.label, existing.label);
  const labelEquivalent = planned.normalizedLabel === normalizedExistingLabel;
  const content = planned.content || contentOf(planned.candidate);
  const existingContent = existing.content || existing.label;

  if (labelEquivalent && planned.label !== existing.label) {
    addDiscrepancy(discrepancies, {
      candidateId: planned.candidate.candidateId,
      code: 'possible_duplicate_or_alias',
      severity: 'error',
      message: `Il candidato '${planned.label}' ha la stessa label normalizzata del nodo canonico '${existing.label}' ma una label testuale diversa.`,
      requiredResolution: 'author_approved_merge',
      existingNodeId: existing.id,
      existingNodeType: existing.type,
      existingNodeLabel: existing.label,
    }, planned.candidate);
  }

  if (labelEquivalent && normalizeText(content) !== normalizeText(existingContent)) {
    addDiscrepancy(discrepancies, {
      candidateId: planned.candidate.candidateId,
      code: 'same_label_content_drift',
      severity: 'error',
      message: `Il candidato '${planned.label}' aggiornerebbe un nodo canonico esistente con contenuto diverso.`,
      requiredResolution: 'author_approved_content_update',
      existingNodeId: existing.id,
      existingNodeType: existing.type,
      existingNodeLabel: existing.label,
    }, planned.candidate);
  }

  if (!labelEquivalent && similarity >= 0.88 && tokenOverlap(content, existingContent) >= 0.5) {
    addDiscrepancy(discrepancies, {
      candidateId: planned.candidate.candidateId,
      code: 'possible_duplicate_or_alias',
      severity: 'error',
      message: `Il candidato '${planned.label}' assomiglia troppo al nodo canonico '${existing.label}'. Serve merge/autorizzazione o arco alias.`,
      requiredResolution: 'author_approved_merge',
      existingNodeId: existing.id,
      existingNodeType: existing.type,
      existingNodeLabel: existing.label,
    }, planned.candidate);
  }

  if ((labelEquivalent || similarity >= 0.82 || tokenOverlap(content, existingContent) >= 0.65) && hasPolarityConflict(content, existingContent)) {
    addDiscrepancy(discrepancies, {
      candidateId: planned.candidate.candidateId,
      code: 'content_polarity_conflict',
      severity: 'error',
      message: `Il candidato '${planned.label}' entra in conflitto di polarita con il nodo canonico '${existing.label}'.`,
      existingNodeId: existing.id,
      existingNodeType: existing.type,
      existingNodeLabel: existing.label,
    }, planned.candidate);
  }
}

function comparePlannedNodes(discrepancies: BibleDiscrepancy[], left: PlannedNode, right: PlannedNode): void {
  if (left.type !== right.type) return;
  const similarity = labelSimilarity(left.label, right.label);
  const sameNormalizedLabel = left.normalizedLabel === right.normalizedLabel;
  const leftContent = left.content || contentOf(left.candidate);
  const rightContent = right.content || contentOf(right.candidate);

  if (sameNormalizedLabel && left.label !== right.label) {
    addDiscrepancy(discrepancies, {
      candidateId: right.candidate.candidateId,
      relatedCandidateId: left.candidate.candidateId,
      code: 'intra_batch_possible_duplicate_or_alias',
      severity: 'error',
      message: `Il batch contiene due label testuali diverse ma normalizzate uguali: '${left.label}' e '${right.label}'.`,
      requiredResolution: 'author_approved_merge',
    }, right.candidate);
  }

  if (sameNormalizedLabel && normalizeText(leftContent) !== normalizeText(rightContent)) {
    addDiscrepancy(discrepancies, {
      candidateId: right.candidate.candidateId,
      relatedCandidateId: left.candidate.candidateId,
      code: 'intra_batch_duplicate_node_drift',
      severity: 'error',
      message: `Il batch contiene due candidati '${left.label}'/'${right.label}' con stessa label normalizzata ma contenuti diversi.`,
      requiredResolution: 'author_approved_content_update',
    }, right.candidate);
  }

  if (!sameNormalizedLabel && similarity >= 0.88 && tokenOverlap(leftContent, rightContent) >= 0.5) {
    addDiscrepancy(discrepancies, {
      candidateId: right.candidate.candidateId,
      relatedCandidateId: left.candidate.candidateId,
      code: 'intra_batch_possible_duplicate_or_alias',
      severity: 'error',
      message: `Il batch contiene candidati quasi duplicati: '${left.label}' e '${right.label}'.`,
      requiredResolution: 'author_approved_merge',
    }, right.candidate);
  }

  if ((sameNormalizedLabel || similarity >= 0.82) && hasPolarityConflict(leftContent, rightContent)) {
    addDiscrepancy(discrepancies, {
      candidateId: right.candidate.candidateId,
      relatedCandidateId: left.candidate.candidateId,
      code: 'intra_batch_content_polarity_conflict',
      severity: 'error',
      message: `Il batch contiene due candidati semanticamente opposti: '${left.label}' e '${right.label}'.`,
    }, right.candidate);
  }
}

function comparePlannedEdges(discrepancies: BibleDiscrepancy[], left: PlannedEdge, right: PlannedEdge): void {
  if (!sameEdgeScope(left, right)) return;
  if (!opposingKinds(left.kind, right.kind)) return;
  addDiscrepancy(discrepancies, {
    candidateId: right.candidate.candidateId,
    relatedCandidateId: left.candidate.candidateId,
    code: 'intra_batch_opposing_edge_kind_conflict',
    severity: 'error',
    message: `Il batch contiene archi opposti '${left.kind}' e '${right.kind}' sugli stessi endpoint.`,
    relationKind: right.kind,
    existingRelationKind: left.kind,
    from: right.from,
    to: right.to,
  }, right.candidate);
}

function compareCandidateEdgeWithCanonical(
  discrepancies: BibleDiscrepancy[],
  planned: PlannedEdge,
  canonicalNodesByKey: Map<string, GraphNode[]>,
  canonicalEdges: GraphEdge[],
): void {
  const fromNodes = canonicalNodesByKey.get(planned.fromKey) ?? [];
  const toNodes = canonicalNodesByKey.get(planned.toKey) ?? [];
  if (!fromNodes.length || !toNodes.length) return;
  const fromIds = new Set(fromNodes.map((node) => node.id));
  const toIds = new Set(toNodes.map((node) => node.id));

  for (const edge of canonicalEdges) {
    const direct = fromIds.has(edge.fromId) && toIds.has(edge.toId);
    const reverse = fromIds.has(edge.toId) && toIds.has(edge.fromId);
    if (!direct && !(reverse && (SYMMETRIC_KINDS.has(edge.kind) || SYMMETRIC_KINDS.has(planned.kind)))) continue;

    if (edge.kind === 'contradicts' && planned.kind !== 'contradicts') {
      addDiscrepancy(discrepancies, {
        candidateId: planned.candidate.candidateId,
        code: 'edge_conflicts_with_existing_contradiction',
        severity: 'error',
        message: `Il candidato '${planned.kind}' insiste su endpoint gia collegati da 'contradicts'.`,
        existingEdgeId: edge.id,
        existingRelationKind: edge.kind,
        relationKind: planned.kind,
        from: planned.from,
        to: planned.to,
      }, planned.candidate);
      continue;
    }

    if (opposingKinds(edge.kind, planned.kind)) {
      addDiscrepancy(discrepancies, {
        candidateId: planned.candidate.candidateId,
        code: 'opposing_edge_kind_conflict',
        severity: 'error',
        message: `Il candidato '${planned.kind}' confligge con l'arco canonico '${edge.kind}' sugli stessi endpoint.`,
        existingEdgeId: edge.id,
        existingRelationKind: edge.kind,
        relationKind: planned.kind,
        from: planned.from,
        to: planned.to,
      }, planned.candidate);
    }
  }
}

export function buildBibleDiscrepancyReport(
  candidates: ContentCandidate[],
  canonicalNodes: GraphNode[],
  canonicalEdges: GraphEdge[],
): BibleDiscrepancyReport {
  const discrepancies: BibleDiscrepancy[] = [];
  const nodes = plannedNodes(candidates);
  const edges = plannedEdges(candidates);
  const canonicalNodesByKey = new Map<string, GraphNode[]>();

  for (const node of canonicalNodes) {
    const key = nodeEndpointKey(node);
    const bucket = canonicalNodesByKey.get(key) ?? [];
    bucket.push(node);
    canonicalNodesByKey.set(key, bucket);
  }

  for (const planned of nodes) {
    for (const existing of canonicalNodes) {
      compareCandidateNodeWithCanonical(discrepancies, planned, existing);
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      comparePlannedNodes(discrepancies, nodes[i], nodes[j]);
    }
  }

  for (const edge of edges) {
    compareCandidateEdgeWithCanonical(discrepancies, edge, canonicalNodesByKey, canonicalEdges);
  }

  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      comparePlannedEdges(discrepancies, edges[i], edges[j]);
    }
  }

  const errors = discrepancies.filter((item) => item.severity === 'error').length;
  const warnings = discrepancies.filter((item) => item.severity === 'warning').length;
  const info = discrepancies.filter((item) => item.severity === 'info').length;
  const blocking = discrepancies.filter((item) => item.blocking).length;

  return {
    discrepancies,
    hasBlockingDiscrepancies: blocking > 0,
    summary: {
      checkedCandidates: candidates.length,
      checkedCanonicalNodes: canonicalNodes.length,
      checkedCanonicalEdges: canonicalEdges.length,
      errors,
      warnings,
      info,
      blocking,
    },
  };
}

// --- Semantic layer -------------------------------------------------------
// Everything above this line is purely lexical (normalization, token overlap,
// polarity dictionaries) and catches contradictions only when the wording is
// close. Embeddings catch the case lexical matching misses: a paraphrase or a
// reworded contradiction that shares no vocabulary with the canonical node.
// This layer is additive: it never replaces the lexical gate, only extends it.

const DEFAULT_HIGH_SIMILARITY_THRESHOLD = 0.92;
const DEFAULT_REVIEW_SIMILARITY_THRESHOLD = 0.8;

export interface SemanticMatch {
  node: GraphNode;
  score: number;
}

export interface SemanticDiscrepancyOptions {
  embedText: (text: string) => Promise<number[]>;
  semanticSearch: (vector: number[], opts: { type?: string; limit?: number }) => Promise<SemanticMatch[]>;
  /** Cosine similarity at or above this value blocks the commit as a likely duplicate/alias. Default 0.92. */
  highSimilarityThreshold?: number;
  /** Cosine similarity at or above this value (but below the high threshold) is a non-blocking advisory. Default 0.80. */
  reviewSimilarityThreshold?: number;
}

function candidateEmbeddingText(candidate: ContentCandidate): string {
  return [candidate.label, candidate.content].filter(Boolean).join('\n').trim();
}

/**
 * Compares each node candidate against the canonical graph by meaning, not by wording.
 * Degrades gracefully: any embedding/search failure for a single candidate is skipped,
 * never thrown — a broken embeddings provider must never block a canonical write that
 * the lexical gate already approved.
 */
export async function buildSemanticDiscrepancies(
  candidates: ContentCandidate[],
  options: SemanticDiscrepancyOptions,
  existingDiscrepancies: BibleDiscrepancy[] = [],
): Promise<BibleDiscrepancy[]> {
  const discrepancies: BibleDiscrepancy[] = [];
  const alreadyFlagged = new Set(
    existingDiscrepancies
      .filter((item) => item.blocking && item.existingNodeId)
      .map((item) => `${item.candidateId}::${item.existingNodeId}`),
  );
  const highThreshold = options.highSimilarityThreshold ?? DEFAULT_HIGH_SIMILARITY_THRESHOLD;
  const reviewThreshold = options.reviewSimilarityThreshold ?? DEFAULT_REVIEW_SIMILARITY_THRESHOLD;
  const nodeCandidates = candidates.filter(
    (candidate) => candidate.candidateKind === 'node' && candidate.targetType && (candidate.label?.trim() || candidate.content?.trim()),
  );

  for (const candidate of nodeCandidates) {
    const text = candidateEmbeddingText(candidate);
    if (!text) continue;

    let vector: number[];
    try {
      vector = await options.embedText(text);
    } catch {
      continue;
    }

    let matches: SemanticMatch[];
    try {
      matches = await options.semanticSearch(vector, { type: candidate.targetType, limit: 5 });
    } catch {
      continue;
    }

    for (const match of matches) {
      if (normalizeText(match.node.label) === normalizeText(candidate.label ?? '')) continue;
      const key = `${candidate.candidateId}::${match.node.id}`;
      if (alreadyFlagged.has(key)) continue;

      if (match.score >= highThreshold) {
        addDiscrepancy(discrepancies, {
          candidateId: candidate.candidateId,
          code: 'possible_duplicate_or_alias_semantic',
          severity: 'error',
          message: `Il candidato '${candidate.label ?? candidate.content}' e semanticamente quasi identico (score ${match.score.toFixed(3)}) al nodo canonico '${match.node.label}', pur con formulazione lessicalmente diversa.`,
          requiredResolution: 'author_approved_merge',
          existingNodeId: match.node.id,
          existingNodeType: match.node.type,
          existingNodeLabel: match.node.label,
        }, candidate);
      } else if (match.score >= reviewThreshold) {
        addDiscrepancy(discrepancies, {
          candidateId: candidate.candidateId,
          code: 'semantic_proximity_review',
          severity: 'warning',
          message: `Il candidato '${candidate.label ?? candidate.content}' e semanticamente vicino (score ${match.score.toFixed(3)}) al nodo canonico '${match.node.label}': possibile parafrasi o contraddizione riformulata, revisione manuale consigliata.`,
          existingNodeId: match.node.id,
          existingNodeType: match.node.type,
          existingNodeLabel: match.node.label,
        }, candidate);
      }
    }
  }

  return discrepancies;
}

/**
 * Shared entry point for both the Bible pipeline (`novel_commit_bible_candidates`) and the
 * chapter pipeline (`novel_commit_chapter_candidates`). Runs the lexical gate above (sync,
 * unchanged, fully covered by existing tests) and layers the semantic gate on top when
 * embeddings are configured. Without `semantic`, behaves exactly like `buildBibleDiscrepancyReport`.
 */
export async function buildCanonDiscrepancyReport(
  candidates: ContentCandidate[],
  canonicalNodes: GraphNode[],
  canonicalEdges: GraphEdge[],
  semantic?: SemanticDiscrepancyOptions,
): Promise<BibleDiscrepancyReport> {
  const lexical = buildBibleDiscrepancyReport(candidates, canonicalNodes, canonicalEdges);
  if (!semantic) return lexical;

  const semanticDiscrepancies = await buildSemanticDiscrepancies(candidates, semantic, lexical.discrepancies);
  if (!semanticDiscrepancies.length) return lexical;

  const discrepancies = [...lexical.discrepancies, ...semanticDiscrepancies];
  const errors = discrepancies.filter((item) => item.severity === 'error').length;
  const warnings = discrepancies.filter((item) => item.severity === 'warning').length;
  const info = discrepancies.filter((item) => item.severity === 'info').length;
  const blocking = discrepancies.filter((item) => item.blocking).length;

  return {
    discrepancies,
    hasBlockingDiscrepancies: blocking > 0,
    summary: { ...lexical.summary, errors, warnings, info, blocking },
  };
}
