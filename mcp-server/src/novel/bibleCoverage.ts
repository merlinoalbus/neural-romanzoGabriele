import type { GraphEdge, GraphNode } from '../graph/neo4jStore.js';
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
  unmappedSections: Array<{ sectionKey: string; label: string; heading?: string; order?: number }>;
  pendingCandidates: number;
  nodesWithoutEvidence: Array<{ id: string; type: string; label: string }>;
  genericRelatedToEdges: number;
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

const CANONICAL_TYPES_REQUIRING_EVIDENCE = new Set([
  'chapter',
  'character',
  'character_state',
  'character_voice',
  'foreshadowing',
  'glossary_term',
  'location',
  'plot_thread',
  'relationship_dynamic',
  'scene',
  'style_rule',
  'theme',
  'timeline_event',
  'world_rule',
]);

function sectionKey(section: GraphNode): string {
  return String(section.metadata.sectionKey ?? section.label);
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
  let pendingCandidates = 0;
  for (const candidate of input.candidates) {
    const status = String(candidate.metadata.status ?? 'pending');
    if (status === 'pending') pendingCandidates++;
    const evidence = candidate.metadata.evidence;
    if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
      const evidenceRecord = evidence as Record<string, unknown>;
      const key = String(evidenceRecord.sectionKey ?? '');
      if (key && (!input.sourceId || evidenceRecord.sourceId === input.sourceId)) candidateSectionKeys.add(key);
    }
  }

  const edgeEvidenceKeys = new Set<string>();
  for (const edge of input.edges) {
    const evidence = edge.metadata.evidence;
    if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
      const evidenceRecord = evidence as Record<string, unknown>;
      const key = String(evidenceRecord.sectionKey ?? '');
      if (key && (!input.sourceId || evidenceRecord.sourceId === input.sourceId)) edgeEvidenceKeys.add(key);
    }
  }

  const coverageFindingKeys = new Set<string>();
  for (const finding of input.coverageFindings ?? []) {
    const evidence = finding.metadata.evidence;
    if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
      const evidenceRecord = evidence as Record<string, unknown>;
      const key = String(evidenceRecord.sectionKey ?? '');
      if (key && (!input.sourceId || evidenceRecord.sourceId === input.sourceId)) coverageFindingKeys.add(key);
    }
    const directKey = typeof finding.metadata.sectionKey === 'string' ? finding.metadata.sectionKey : '';
    if (directKey && (!input.sourceId || finding.metadata.sourceId === input.sourceId)) coverageFindingKeys.add(directKey);
  }

  const canonicalEvidenceKeys = new Set<string>();
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
            if (key && (!input.sourceId || evidenceRecord.sourceId === input.sourceId)) canonicalEvidenceKeys.add(key);
          }
        }
      } else if (evidence && typeof evidence === 'object') {
        const evidenceRecord = evidence as Record<string, unknown>;
        const key = String(evidenceRecord.sectionKey ?? '');
        if (key && (!input.sourceId || evidenceRecord.sourceId === input.sourceId)) canonicalEvidenceKeys.add(key);
      }
      if (node.provenance.sectionKey && (!input.sourceId || node.provenance.sourceId === input.sourceId)) {
        canonicalEvidenceKeys.add(String(node.provenance.sectionKey));
      }
      if (node.metadata.sectionKey && (!input.sourceId || node.metadata.sourceId === input.sourceId)) {
        canonicalEvidenceKeys.add(String(node.metadata.sectionKey));
      }
      return !hasEvidence(node, input.sourceId);
    })
    .map((node) => ({ id: node.id, type: node.type, label: node.label }));

  const mappedKeys = new Set([...candidateSectionKeys, ...canonicalEvidenceKeys, ...edgeEvidenceKeys, ...coverageFindingKeys]);
  const unmappedSections = input.sections
    .filter((section) => !mappedKeys.has(sectionKey(section)))
    .map((section) => ({
      sectionKey: sectionKey(section),
      label: section.label,
      heading: typeof section.metadata.heading === 'string' ? section.metadata.heading : undefined,
      order: typeof section.metadata.order === 'number' ? section.metadata.order : undefined,
    }))
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
  if (nodesWithoutEvidence.length) {
    findings.push({
      code: 'canonical_nodes_without_evidence',
      severity: 'error',
      message: 'Alcuni nodi canonici non hanno evidence/provenance sufficiente verso la Bibbia.',
      evidence: { count: nodesWithoutEvidence.length },
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
    unmappedSections,
    pendingCandidates,
    nodesWithoutEvidence,
    genericRelatedToEdges,
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
