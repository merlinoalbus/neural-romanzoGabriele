import type { GraphEdge, GraphNode } from '../graph/neo4jStore.js';
import { COMMITTABLE_BIBLE_NODE_TYPES } from './bibleCandidates.js';
import { groupNarrativeContext, type NarrativeContextGroups } from './context.js';
import { normalizeChapterLabel } from './domain.js';

export interface BibleCoverageFinding {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  evidence?: Record<string, unknown>;
}

export interface BibleCoverageReport {
  sourceId?: string;
  sectionCount: number;
  mappedSections: number;
  claimMappedSections: number;
  canonicalNodeMappedSections: number;
  canonicalEdgeMappedSections: number;
  unmappedSections: Array<{ sectionKey: string; label: string; heading?: string; order?: number }>;
  sectionMappedOnly: Array<{ sectionKey: string; label: string; heading?: string; order?: number }>;
  claimMappedOnly: Array<{ sectionKey: string; label: string; heading?: string; order?: number }>;
  pendingCandidates: number;
  nodesWithoutEvidence: Array<{ id: string; type: string; label: string }>;
  genericRelatedToEdges: number;
  duplicateCanonicalNodes: Array<{ type: string; label: string; count: number }>;
  untypedClaims: Array<{ id: string; label: string; sectionKey?: string }>;
  pendingEdgeCandidatesWithMissingEndpoints: Array<{ candidateId: string; endpoint: 'from' | 'to'; type: string; label: string }>;
  findings: BibleCoverageFinding[];
}

export interface ChapterContextPacket {
  task: string;
  chapterNumber: number;
  chapterLabel: string;
  query: string;
  context: NarrativeContextGroups;
  counts: Record<string, number>;
  coverageWarnings: BibleCoverageFinding[];
}

const CANONICAL_TYPES_REQUIRING_EVIDENCE = new Set<string>(COMMITTABLE_BIBLE_NODE_TYPES);

function sectionKey(section: GraphNode): string {
  return String(section.metadata.sectionKey ?? section.label);
}

function sectionSummary(section: GraphNode): { sectionKey: string; label: string; heading?: string; order?: number } {
  return {
    sectionKey: sectionKey(section),
    label: section.label,
    heading: typeof section.metadata.heading === 'string' ? section.metadata.heading : undefined,
    order: typeof section.metadata.order === 'number' ? section.metadata.order : undefined,
  };
}

function evidenceSectionKey(evidence: unknown, sourceId?: string): string | null {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  const evidenceRecord = evidence as Record<string, unknown>;
  const key = String(evidenceRecord.sectionKey ?? '');
  if (!key) return null;
  if (sourceId && evidenceRecord.sourceId !== sourceId) return null;
  return key;
}

function candidatePayload(candidate: GraphNode): Record<string, unknown> {
  const payload = candidate.metadata.candidate;
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
}

function candidateMetadata(candidate: GraphNode): Record<string, unknown> {
  const payloadMetadata = candidatePayload(candidate).metadata;
  return payloadMetadata && typeof payloadMetadata === 'object' && !Array.isArray(payloadMetadata)
    ? (payloadMetadata as Record<string, unknown>)
    : {};
}

function evidenceMatchesSource(evidence: Record<string, unknown>, sourceId?: string): boolean {
  const sectionKeyValue = evidence.sectionKey;
  if (typeof sectionKeyValue !== 'string' || !sectionKeyValue.trim()) return false;
  if (!sourceId) return true;
  return evidence.sourceId === sourceId;
}

function hasEvidence(node: GraphNode, sourceId?: string): boolean {
  if (node.type === 'bible_section' || node.type === 'bible_outline') return true;
  const evidence = node.metadata.evidence;
  if (Array.isArray(evidence)) {
    if (evidence.some((item) => item && typeof item === 'object' && evidenceMatchesSource(item as Record<string, unknown>, sourceId))) return true;
  } else if (evidence && typeof evidence === 'object' && evidenceMatchesSource(evidence as Record<string, unknown>, sourceId)) {
    return true;
  }
  if (typeof node.provenance.sectionKey === 'string' && node.provenance.sectionKey.trim()) {
    return !sourceId || node.provenance.sourceId === sourceId;
  }
  if (typeof node.metadata.sectionKey === 'string' && node.metadata.sectionKey.trim()) {
    return !sourceId || node.metadata.sourceId === sourceId;
  }
  return false;
}

export function buildBibleCoverageReport(input: {
  sourceId?: string;
  sections: GraphNode[];
  candidates: GraphNode[];
  canonicalNodes: GraphNode[];
  coverageFindings?: GraphNode[];
  edges: GraphEdge[];
}): BibleCoverageReport {
  const candidateSectionKeys = new Set<string>();
  const sectionMappedKeys = new Set<string>();
  const claimMappedKeys = new Set<string>();
  let pendingCandidates = 0;
  for (const candidate of input.candidates) {
    const status = String(candidate.metadata.status ?? 'pending');
    if (status === 'pending') pendingCandidates++;
    const key = evidenceSectionKey(candidate.metadata.evidence, input.sourceId);
    if (key) {
      candidateSectionKeys.add(key);
      const payload = candidatePayload(candidate);
      const metadata = candidateMetadata(candidate);
      const targetType = String(candidate.metadata.targetType ?? payload.targetType ?? '');
      const granularity = String(metadata.granularity ?? '');
      if (targetType === 'bible_claim' || granularity === 'atomic') claimMappedKeys.add(key);
      if (granularity === 'section') sectionMappedKeys.add(key);
    }
  }

  const edgeEvidenceKeys = new Set<string>();
  for (const edge of input.edges) {
    const key = evidenceSectionKey(edge.metadata.evidence, input.sourceId);
    if (key) edgeEvidenceKeys.add(key);
  }

  const coverageFindingKeys = new Set<string>();
  for (const finding of input.coverageFindings ?? []) {
    const key = evidenceSectionKey(finding.metadata.evidence, input.sourceId);
    if (key) coverageFindingKeys.add(key);
    const directKey = typeof finding.metadata.sectionKey === 'string' ? finding.metadata.sectionKey : '';
    if (directKey && (!input.sourceId || finding.metadata.sourceId === input.sourceId)) coverageFindingKeys.add(directKey);
  }

  const canonicalEvidenceKeys = new Set<string>();
  const canonicalNodeEvidenceKeys = new Set<string>();
  const typedCanonicalNodeEvidenceKeys = new Set<string>();
  const canonicalClaimKeys = new Set<string>();
  const nodesWithoutEvidence = input.canonicalNodes
    .filter((node) => CANONICAL_TYPES_REQUIRING_EVIDENCE.has(node.type))
    .filter((node) => node.metadata.canonStatus === 'canonical')
    .filter((node) => {
      const evidence = node.metadata.evidence;
      if (Array.isArray(evidence)) {
        for (const item of evidence) {
          if (item && typeof item === 'object') {
            const evidenceRecord = item as Record<string, unknown>;
            const key = String(evidenceRecord.sectionKey ?? '');
            if (key && (!input.sourceId || evidenceRecord.sourceId === input.sourceId)) {
              canonicalEvidenceKeys.add(key);
              canonicalNodeEvidenceKeys.add(key);
              if (node.type !== 'bible_claim') typedCanonicalNodeEvidenceKeys.add(key);
              if (node.type === 'bible_claim') canonicalClaimKeys.add(key);
            }
          }
        }
      } else if (evidence && typeof evidence === 'object') {
        const evidenceRecord = evidence as Record<string, unknown>;
        const key = String(evidenceRecord.sectionKey ?? '');
        if (key && (!input.sourceId || evidenceRecord.sourceId === input.sourceId)) {
          canonicalEvidenceKeys.add(key);
          canonicalNodeEvidenceKeys.add(key);
          if (node.type !== 'bible_claim') typedCanonicalNodeEvidenceKeys.add(key);
          if (node.type === 'bible_claim') canonicalClaimKeys.add(key);
        }
      }
      if (node.provenance.sectionKey && (!input.sourceId || node.provenance.sourceId === input.sourceId)) {
        canonicalEvidenceKeys.add(String(node.provenance.sectionKey));
        canonicalNodeEvidenceKeys.add(String(node.provenance.sectionKey));
        if (node.type !== 'bible_claim') typedCanonicalNodeEvidenceKeys.add(String(node.provenance.sectionKey));
        if (node.type === 'bible_claim') canonicalClaimKeys.add(String(node.provenance.sectionKey));
      }
      if (node.metadata.sectionKey && (!input.sourceId || node.metadata.sourceId === input.sourceId)) {
        canonicalEvidenceKeys.add(String(node.metadata.sectionKey));
        canonicalNodeEvidenceKeys.add(String(node.metadata.sectionKey));
        if (node.type !== 'bible_claim') typedCanonicalNodeEvidenceKeys.add(String(node.metadata.sectionKey));
        if (node.type === 'bible_claim') canonicalClaimKeys.add(String(node.metadata.sectionKey));
      }
      return !hasEvidence(node, input.sourceId);
    })
    .map((node) => ({ id: node.id, type: node.type, label: node.label }));

  const duplicateCounts = new Map<string, { type: string; label: string; count: number }>();
  for (const node of input.canonicalNodes.filter((entry) => entry.metadata.canonStatus === 'canonical')) {
    const key = `${node.type}::${node.label}`;
    const current = duplicateCounts.get(key) ?? { type: node.type, label: node.label, count: 0 };
    current.count++;
    duplicateCounts.set(key, current);
  }
  const duplicateCanonicalNodes = [...duplicateCounts.values()].filter((entry) => entry.count > 1);

  const claimIds = new Set(input.canonicalNodes.filter((node) => node.type === 'bible_claim' && node.metadata.canonStatus === 'canonical').map((node) => node.id));
  const typedClaimIds = new Set<string>();
  for (const edge of input.edges) {
    if (['applies_to', 'derived_from', 'part_of'].includes(edge.kind)) continue;
    if (claimIds.has(edge.fromId)) typedClaimIds.add(edge.fromId);
    if (claimIds.has(edge.toId)) typedClaimIds.add(edge.toId);
  }
  const untypedClaims = input.canonicalNodes
    .filter((node) => node.type === 'bible_claim' && node.metadata.canonStatus === 'canonical' && !typedClaimIds.has(node.id))
    .map((node) => {
      const evidence = Array.isArray(node.metadata.evidence) ? node.metadata.evidence[0] : node.metadata.evidence;
      return { id: node.id, label: node.label, sectionKey: evidenceSectionKey(evidence, input.sourceId) ?? undefined };
    });

  const canonicalNodeKeys = new Set(input.canonicalNodes.map((node) => `${node.type}::${node.label}`));
  const pendingEdgeCandidatesWithMissingEndpoints: Array<{ candidateId: string; endpoint: 'from' | 'to'; type: string; label: string }> = [];
  for (const candidate of input.candidates) {
    if (String(candidate.metadata.status ?? 'pending') !== 'pending') continue;
    const payload = candidatePayload(candidate);
    if (String(candidate.metadata.candidateKind ?? payload.candidateKind ?? '') !== 'edge') continue;
    for (const endpointName of ['from', 'to'] as const) {
      const endpoint = payload[endpointName];
      if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) continue;
      const record = endpoint as Record<string, unknown>;
      const type = String(record.type ?? '');
      const label = String(record.label ?? '');
      if (type && label && !canonicalNodeKeys.has(`${type}::${label}`)) {
        pendingEdgeCandidatesWithMissingEndpoints.push({ candidateId: candidate.label, endpoint: endpointName, type, label });
      }
    }
  }

  const allClaimMappedKeys = new Set([...claimMappedKeys, ...canonicalClaimKeys]);
  const mappedKeys = new Set([...candidateSectionKeys, ...canonicalEvidenceKeys, ...edgeEvidenceKeys, ...coverageFindingKeys]);
  const unmappedSections = input.sections
    .filter((section) => !mappedKeys.has(sectionKey(section)))
    .map(sectionSummary)
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0) || a.label.localeCompare(b.label));
  const sectionMappedOnly = input.sections
    .filter((section) => {
      const key = sectionKey(section);
      return sectionMappedKeys.has(key) && !allClaimMappedKeys.has(key) && !typedCanonicalNodeEvidenceKeys.has(key) && !edgeEvidenceKeys.has(key) && !coverageFindingKeys.has(key);
    })
    .map(sectionSummary)
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0) || a.label.localeCompare(b.label));
  const claimMappedOnly = input.sections
    .filter((section) => {
      const key = sectionKey(section);
      return allClaimMappedKeys.has(key) && !typedCanonicalNodeEvidenceKeys.has(key) && !edgeEvidenceKeys.has(key) && !coverageFindingKeys.has(key);
    })
    .map(sectionSummary)
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0) || a.label.localeCompare(b.label));

  const genericRelatedToEdges = input.edges.filter((edge) => edge.kind === 'related_to').length;
  const findings: BibleCoverageFinding[] = [];
  if (!input.sections.length) {
    findings.push({ code: 'no_bible_sections', severity: 'error', message: 'Nessuna sezione Bibbia importata per il sourceId richiesto.' });
  }
  if (unmappedSections.length) {
    findings.push({
      code: 'unmapped_bible_sections',
      severity: 'warning',
      message: 'Esistono sezioni Bibbia non ancora mappate in candidati o nodi canonici.',
      evidence: { count: unmappedSections.length },
    });
  }
  if (pendingCandidates) {
    findings.push({
      code: 'pending_bible_candidates',
      severity: 'info',
      message: 'Esistono candidati semantici in attesa di validazione/commit.',
      evidence: { count: pendingCandidates },
    });
  }
  if (sectionMappedOnly.length) {
    findings.push({
      code: 'section_mapped_only',
      severity: 'info',
      message: 'Alcune sezioni hanno solo un mapping strutturale di sezione e richiedono estrazione atomica.',
      evidence: { count: sectionMappedOnly.length },
    });
  }
  if (claimMappedOnly.length) {
    findings.push({
      code: 'claim_mapped_only',
      severity: 'warning',
      message: 'Alcune sezioni hanno solo claim atomici e non ancora nodi/archi canonici tipizzati.',
      evidence: { count: claimMappedOnly.length },
    });
  }
  if (nodesWithoutEvidence.length) {
    findings.push({
      code: 'canonical_nodes_without_evidence',
      severity: 'error',
      message: 'Alcuni nodi canonici non hanno evidence/provenance sufficiente verso la Bibbia.',
      evidence: { count: nodesWithoutEvidence.length },
    });
  }
  if (duplicateCanonicalNodes.length) {
    findings.push({
      code: 'duplicate_canonical_nodes',
      severity: 'warning',
      message: 'Sono presenti nodi canonici duplicati per tipo e label.',
      evidence: { count: duplicateCanonicalNodes.length },
    });
  }
  if (untypedClaims.length) {
    findings.push({
      code: 'untyped_bible_claims',
      severity: 'warning',
      message: 'Alcuni bible_claim canonici non sono ancora collegati a nodi o archi semantici specifici.',
      evidence: { count: untypedClaims.length },
    });
  }
  if (pendingEdgeCandidatesWithMissingEndpoints.length) {
    findings.push({
      code: 'pending_edge_candidates_missing_endpoints',
      severity: 'warning',
      message: 'Alcuni candidati arco pendenti puntano a endpoint non presenti tra i nodi canonici disponibili.',
      evidence: { count: pendingEdgeCandidatesWithMissingEndpoints.length },
    });
  }
  if (genericRelatedToEdges) {
    findings.push({
      code: 'generic_related_to_edges',
      severity: 'warning',
      message: 'Sono presenti relazioni related_to da tipizzare quando possibile.',
      evidence: { count: genericRelatedToEdges },
    });
  }

  return {
    sourceId: input.sourceId,
    sectionCount: input.sections.length,
    mappedSections: mappedKeys.size,
    claimMappedSections: allClaimMappedKeys.size,
    canonicalNodeMappedSections: typedCanonicalNodeEvidenceKeys.size,
    canonicalEdgeMappedSections: new Set([...edgeEvidenceKeys, ...coverageFindingKeys]).size,
    unmappedSections,
    sectionMappedOnly,
    claimMappedOnly,
    pendingCandidates,
    nodesWithoutEvidence,
    genericRelatedToEdges,
    duplicateCanonicalNodes,
    untypedClaims,
    pendingEdgeCandidatesWithMissingEndpoints,
    findings,
  };
}

export function buildChapterContextPacket(input: {
  task: string;
  chapterNumber: number;
  query: string;
  nodes: GraphNode[];
  coverageReport?: BibleCoverageReport;
  includeDrafts?: boolean;
}): ChapterContextPacket {
  const context = groupNarrativeContext(input.nodes, { includeDrafts: input.includeDrafts });
  const counts = Object.fromEntries(Object.entries(context).map(([key, value]) => [key, value.length]));
  const coverageWarnings = input.coverageReport?.findings.filter((finding) => finding.severity !== 'info') ?? [];
  return {
    task: input.task,
    chapterNumber: input.chapterNumber,
    chapterLabel: normalizeChapterLabel(input.chapterNumber),
    query: input.query,
    context,
    counts,
    coverageWarnings,
  };
}
