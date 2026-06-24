import type { GraphEdge, GraphNode } from '../graph/neo4jStore.js';
import type { BibleCandidate, BibleCandidateEndpoint } from './bibleCandidates.js';

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
  from?: BibleCandidateEndpoint;
  to?: BibleCandidateEndpoint;
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
  candidate: BibleCandidate;
  type: string;
  label: string;
  content: string;
  normalizedLabel: string;
};

type PlannedEdge = {
  candidate: BibleCandidate;
  kind: string;
  fromKey: string;
  toKey: string;
  from: BibleCandidateEndpoint;
  to: BibleCandidateEndpoint;
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

function contentOf(candidate: BibleCandidate): string {
  return [candidate.label, candidate.content, candidate.rationale].filter(Boolean).join(' ');
}

function endpointKey(endpoint: BibleCandidateEndpoint): string {
  return `${endpoint.type}::${normalizeText(endpoint.label)}`;
}

function nodeEndpointKey(node: Pick<GraphNode, 'type' | 'label'>): string {
  return `${node.type}::${normalizeText(node.label)}`;
}

function hasResolution(candidate: BibleCandidate, resolution: string): boolean {
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

function hasPolarityConflict(a: unknown, b: unknown): boolean {
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
  candidate?: BibleCandidate,
): void {
  const authorized = discrepancy.requiredResolution ? Boolean(candidate && hasResolution(candidate, discrepancy.requiredResolution)) : false;
  const blocking = discrepancy.severity === 'error' && !authorized;
  discrepancies.push({ ...discrepancy, authorized: authorized || undefined, blocking });
}

function plannedNodes(candidates: BibleCandidate[]): PlannedNode[] {
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

function plannedEdges(candidates: BibleCandidate[]): PlannedEdge[] {
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
  candidates: BibleCandidate[],
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
