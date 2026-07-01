import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { KG_KINDS_LIST } from '../graph/ontology.js';
import * as kg from '../graph/neo4jStore.js';
import {
  BIBLE_CANDIDATE_FAMILIES,
  BIBLE_CANDIDATE_GRANULARITIES,
  COMMITTABLE_BIBLE_NODE_TYPES,
  extractBibleCandidatesFromSection,
  validateBibleCandidateForCommit,
  type BibleCandidate,
  type BibleCandidateFamily,
  type BibleCandidateGranularity,
} from '../novel/bibleCandidates.js';
import { buildBibleCoverageReport, buildChapterContextPacket } from '../novel/bibleCoverage.js';
import { buildBibleDiscrepancyReport } from '../novel/bibleDiscrepancy.js';
import { buildBibleSectionsPlan, previewBibleSection, type BibleSectionsPlan } from '../novel/bibleSections.js';
import { composeRecallQuery } from '../novel/context.js';
import { normalizeChapterLabel, NOVEL_NODE_TYPES } from '../novel/domain.js';
import { errorObj, toolError, toolStructured } from './responseHelpers.js';

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

const edgeZ = z.object({
  id: z.string(),
  fromId: z.string(),
  toId: z.string(),
  kind: z.string(),
  weight: z.number(),
  metadata: jsonObj,
  provenance: jsonObj,
  createdAt: z.string(),
});

const bibleSectionInputZ = z.object({
  sectionId: z.string().optional(),
  heading: z.string(),
  text: z.string(),
  order: z.number().int().positive(),
  level: z.number().int().positive().optional(),
  path: z.array(z.string()).optional(),
  parentSectionId: z.string().optional(),
  outlineNumber: z.string().optional(),
  headingStyle: z.string().optional(),
  pageStart: z.number().int().positive().optional(),
  pageEnd: z.number().int().positive().optional(),
  metadata: jsonObj.optional(),
});

const bibleSectionPreviewZ = z.object({
  sectionKey: z.string(),
  label: z.string(),
  heading: z.string(),
  order: z.number(),
  level: z.number(),
  path: z.array(z.string()),
  parentSectionKey: z.string().optional(),
  contentHash: z.string(),
  charCount: z.number(),
  wordCount: z.number(),
});

const ingestBibleSectionsSummaryZ = z.object({
  sourceId: z.string(),
  sourceType: z.string(),
  sectionsReceived: z.number(),
  nodesPlanned: z.number(),
  edgesPlanned: z.number(),
  nodesWritten: z.number(),
  edgesWritten: z.number(),
});

const candidateEndpointZ = z.object({
  type: z.string(),
  label: z.string(),
});

const candidateEvidenceSpanZ = z.object({
  startChar: z.number().int().nonnegative().optional(),
  endChar: z.number().int().nonnegative().optional(),
  paragraphIndex: z.number().int().nonnegative().optional(),
});

const candidateEvidenceZ = z.object({
  sourceId: z.string(),
  sectionKey: z.string(),
  sectionLabel: z.string().optional(),
  contentHash: z.string().optional(),
  path: z.array(z.string()).optional(),
  span: candidateEvidenceSpanZ.optional(),
  textSnippet: z.string().optional(),
});

const bibleCandidateZ = z.object({
  candidateId: z.string(),
  candidateKind: z.enum(['node', 'edge']),
  targetType: z.string().optional(),
  label: z.string().optional(),
  content: z.string().optional(),
  relationKind: z.string().optional(),
  from: candidateEndpointZ.optional(),
  to: candidateEndpointZ.optional(),
  evidence: candidateEvidenceZ,
  confidence: z.number(),
  rationale: z.string(),
  metadata: jsonObj,
});

const candidateSummaryZ = z.object({
  sourceId: z.string().optional(),
  sectionsScanned: z.number(),
  candidatesPlanned: z.number(),
  candidatesWritten: z.number(),
  candidatesCommitted: z.number().optional(),
  edgesCommitted: z.number().optional(),
});

const ontologyPacketZ = z.object({
  nodeTypes: z.array(z.string()),
  relationKinds: z.array(z.string()),
  committableNodeTypes: z.array(z.string()),
  candidateFamilies: z.array(z.string()),
  granularities: z.array(z.string()),
  evidencePolicy: z.array(z.string()),
});

const coverageFindingZ = z.object({
  code: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string(),
  evidence: jsonObj.optional(),
});

const bibleDiscrepancyZ = z.object({
  candidateId: z.string().optional(),
  relatedCandidateId: z.string().optional(),
  code: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string(),
  blocking: z.boolean(),
  authorized: z.boolean().optional(),
  requiredResolution: z.string().optional(),
  existingNodeId: z.string().optional(),
  existingNodeType: z.string().optional(),
  existingNodeLabel: z.string().optional(),
  existingEdgeId: z.string().optional(),
  existingRelationKind: z.string().optional(),
  relationKind: z.string().optional(),
  from: candidateEndpointZ.optional(),
  to: candidateEndpointZ.optional(),
});

const coverageReportZ = z.object({
  sourceId: z.string().optional(),
  sectionCount: z.number(),
  mappedSections: z.number(),
  claimMappedSections: z.number(),
  canonicalNodeMappedSections: z.number(),
  canonicalEdgeMappedSections: z.number(),
  unmappedSections: z.array(z.object({ sectionKey: z.string(), label: z.string(), heading: z.string().optional(), order: z.number().optional() })),
  sectionMappedOnly: z.array(z.object({ sectionKey: z.string(), label: z.string(), heading: z.string().optional(), order: z.number().optional() })),
  claimMappedOnly: z.array(z.object({ sectionKey: z.string(), label: z.string(), heading: z.string().optional(), order: z.number().optional() })),
  pendingCandidates: z.number(),
  nodesWithoutEvidence: z.array(z.object({ id: z.string(), type: z.string(), label: z.string() })),
  genericRelatedToEdges: z.number(),
  duplicateCanonicalNodes: z.array(z.object({ type: z.string(), label: z.string(), count: z.number() })),
  untypedClaims: z.array(z.object({ id: z.string(), label: z.string(), sectionKey: z.string().optional() })),
  pendingEdgeCandidatesWithMissingEndpoints: z.array(z.object({
    candidateId: z.string(),
    endpoint: z.enum(['from', 'to']),
    type: z.string(),
    label: z.string(),
  })),
  findings: z.array(coverageFindingZ),
});

const paragraphStatusValueZ = z.enum(['content_section', 'header_only', 'requires_claim_cleanup', 'blocked']);

const bibleParagraphStatusZ = z.object({
  sourceId: z.string(),
  sectionKey: z.string(),
  paragraphStatus: paragraphStatusValueZ,
  section: nodeZ.optional(),
  directTextEmpty: z.boolean(),
  candidates: z.array(nodeZ),
  candidate_pending_count: z.number(),
  residualCanonicalClaims: z.array(nodeZ),
  residualCanonicalClaims_count: z.number(),
  workItemsPending_count: z.number(),
  blockingFindings: z.array(z.string()),
});

const bibleParagraphReconciliationPacketZ = bibleParagraphStatusZ.extend({
  sourceText: z.string(),
  path: z.array(z.string()),
  parentSectionId: z.string().optional(),
  childSections: z.array(nodeZ),
  ontology: ontologyPacketZ,
  recommendedWorkflowBranch: z.enum(['reconcile_candidates', 'classify_structural_claims', 'close_header_only', 'blocked']),
});

const structuralClaimClassificationZ = z.object({
  id: z.string(),
  label: z.string(),
  content: z.string(),
  classificationHint: z.enum(['structural_noise', 'section_metadata', 'semantic_claim', 'ambiguous']),
  reason: z.string(),
});

const bibleStructuralClaimPacketZ = z.object({
  sourceId: z.string(),
  sectionKey: z.string(),
  heading: z.string().optional(),
  directTextEmpty: z.boolean(),
  claims: z.array(nodeZ),
  classifications: z.array(structuralClaimClassificationZ),
  duplicatedSectionMetadata: z.boolean(),
});

const bibleClaimAssimilationPacketZ = z.object({
  sourceId: z.string(),
  sectionKey: z.string(),
  claimNodeId: z.string(),
  claimNode: nodeZ.optional(),
  sourceSection: nodeZ.optional(),
  sourceText: z.string(),
  atomicConcepts: z.array(z.object({
    index: z.number(),
    text: z.string(),
    coveredBy: z.array(z.object({
      id: z.string(),
      type: z.string(),
      label: z.string(),
      coverage: z.enum(['exact', 'partial', 'evidence_only']),
      reason: z.string(),
    })),
  })),
  canonicalPrimaryTargets: z.array(nodeZ),
  canonicalSecondaryTargets: z.array(nodeZ),
  targetNeighbors: z.array(z.object({
    targetId: z.string(),
    nodes: z.array(nodeZ),
    edges: z.array(edgeZ),
  })),
  claimNeighborNodes: z.array(nodeZ),
  claimNeighborEdges: z.array(edgeZ),
  evidenceCoverage: z.object({
    sourceSectionMatches: z.boolean(),
    claimTextInSource: z.boolean(),
    allAtomicConceptsCovered: z.boolean(),
  }),
  deleteEligibility: z.object({
    eligible: z.boolean(),
    reason: z.string(),
    allowedDeleteNodeIds: z.array(z.string()),
    requiredPreserveNodeIds: z.array(z.string()),
  }),
  orphanRisk: z.array(z.string()),
  blockingFindings: z.array(z.string()),
});

const bibleCandidatePacketZ = z.object({
  sourceId: z.string(),
  candidateId: z.string(),
  candidate: nodeZ.optional(),
  section: nodeZ.optional(),
  sourceSnippet: z.string().optional(),
  existingCanonicalMatches: z.array(nodeZ),
  duplicateRisks: z.array(z.string()),
  commitEligibility: z.object({
    eligible: z.boolean(),
    blockingFindings: z.array(z.string()),
  }),
});

const bibleValidationPacketZ = z.object({
  sourceId: z.string(),
  sectionKey: z.string(),
  scope: z.enum(['paragraph']),
  paragraph: bibleParagraphStatusZ,
  checklist: z.array(z.object({ item: z.string(), ok: z.boolean(), evidence: z.string() })),
  blockingGaps: z.array(z.string()),
});

const biblePostwriteStatusZ = z.object({
  sourceId: z.string(),
  sectionKey: z.string(),
  paragraph: bibleParagraphStatusZ,
  touchedNodes: z.array(nodeZ),
  touchedNodeStatuses: z.array(z.object({ id: z.string(), found: z.boolean(), edgeCount: z.number(), genericRelatedToEdges: z.number() })),
  paragraphCompletionEligible: z.boolean(),
  blockingFindings: z.array(z.string()),
});

const bibleProgressEligibilityZ = z.object({
  sourceId: z.string(),
  sectionKey: z.string(),
  eligible: z.boolean(),
  reason: z.string(),
  candidate_pending_count: z.number(),
  residualCanonicalClaims_count: z.number(),
  workItemsPending_count: z.number(),
  blockingFindings: z.array(z.string()),
  requiredValidators: z.array(z.string()),
});

const bibleCheckpointSummaryZ = z.object({
  sourceId: z.string(),
  fromSectionKey: z.string().optional(),
  paragraphs: z.array(z.object({
    sectionKey: z.string(),
    heading: z.string().optional(),
    paragraphStatus: paragraphStatusValueZ,
    candidate_pending_count: z.number(),
    residualCanonicalClaims_count: z.number(),
    workItemsPending_count: z.number(),
  })),
  blockedParagraphs: z.array(z.string()),
  globalCoverageRequired: z.boolean(),
});

const contextGroupsZ = z.object({
  artifacts: z.array(nodeZ),
  bibleClaims: z.array(nodeZ),
  chapters: z.array(nodeZ),
  drafts: z.array(nodeZ),
  characters: z.array(nodeZ),
  characterBeliefs: z.array(nodeZ),
  characterGoals: z.array(nodeZ),
  characterStates: z.array(nodeZ),
  characterTraits: z.array(nodeZ),
  characterVoices: z.array(nodeZ),
  characterWounds: z.array(nodeZ),
  conflicts: z.array(nodeZ),
  emotionalStates: z.array(nodeZ),
  entityClasses: z.array(nodeZ),
  factions: z.array(nodeZ),
  relationshipDynamics: z.array(nodeZ),
  themes: z.array(nodeZ),
  locations: z.array(nodeZ),
  worldRules: z.array(nodeZ),
  knowledgeStates: z.array(nodeZ),
  motifs: z.array(nodeZ),
  mysteries: z.array(nodeZ),
  narrativeConstraints: z.array(nodeZ),
  powers: z.array(nodeZ),
  precognitiveData: z.array(nodeZ),
  prophecies: z.array(nodeZ),
  revelations: z.array(nodeZ),
  secrets: z.array(nodeZ),
  styleRules: z.array(nodeZ),
  symbols: z.array(nodeZ),
  plotThreads: z.array(nodeZ),
  foreshadowing: z.array(nodeZ),
  glossaryTerms: z.array(nodeZ),
  timelineEvents: z.array(nodeZ),
  other: z.array(nodeZ),
});

async function writeBibleSectionsPlan(plan: BibleSectionsPlan): Promise<{
  root: kg.GraphNode;
  sections: kg.GraphNode[];
  nodesWritten: number;
  edgesWritten: number;
}> {
  const rootWrite = await kg.upsertNode({
    type: plan.root.type,
    label: plan.root.label,
    content: plan.root.content,
    metadata: plan.root.metadata,
    provenance: plan.root.provenance,
  });
  const nodeByKey = new Map<string, kg.GraphNode>([[plan.root.key, rootWrite.node]]);
  const sectionNodes: kg.GraphNode[] = [];
  let nodesWritten = 1;

  for (const section of plan.sections) {
    const written = await kg.upsertNode({
      type: section.type,
      label: section.label,
      content: section.content,
      metadata: section.metadata,
      provenance: section.provenance,
    });
    nodeByKey.set(section.key, written.node);
    sectionNodes.push(written.node);
    nodesWritten++;
  }

  let edgesWritten = 0;
  for (const edge of plan.edges) {
    const from = nodeByKey.get(edge.fromKey);
    const to = nodeByKey.get(edge.toKey);
    if (!from || !to) throw new Error(`invalid_bible_sections_plan: missing node for edge ${edge.fromKey}->${edge.toKey}`);
    await kg.link({
      fromId: from.id,
      toId: to.id,
      kind: edge.kind,
      metadata: edge.metadata,
      provenance: edge.provenance,
    });
    edgesWritten++;
  }

  return { root: rootWrite.node, sections: sectionNodes, nodesWritten, edgesWritten };
}

function stableHash(value: string, length = 16): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
}

function candidateBatchLabel(sourceId: string, candidates: BibleCandidate[]): string {
  return `${sourceId}::candidate-batch::${stableHash(candidates.map((candidate) => candidate.candidateId).sort().join('\n'))}`;
}

function toCandidate(value: unknown): BibleCandidate {
  return value as BibleCandidate;
}

export async function listBibleSectionsForExtraction(input: { sourceId: string; sectionKeys?: string[]; limit?: number }): Promise<kg.GraphNode[]> {
  const keys = new Set((input.sectionKeys ?? []).map((key) => key.trim()).filter(Boolean));
  if (keys.size) {
    const sections = await Promise.all([...keys].map((key) => kg.getNodeByTypeLabel('bible_section', `${input.sourceId}::${key}`)));
    return sections.filter((section): section is kg.GraphNode =>
      Boolean(section && section.metadata.sourceId === input.sourceId && keys.has(String(section.metadata.sectionKey ?? ''))),
    );
  }
  return kg.listNodesByTypeLabelPrefix('bible_section', `${input.sourceId}::`, { limit: input.limit });
}

export async function listBibleCandidatesForSource(sourceId?: string, limit?: number): Promise<kg.GraphNode[]> {
  const candidates = await kg.listNodesByType('bible_candidate', { limit: limit ?? 500 });
  return sourceId ? candidates.filter((candidate) => candidate.metadata.sourceId === sourceId) : candidates;
}

export function bibleOntologyPacket(): z.infer<typeof ontologyPacketZ> {
  return {
    nodeTypes: [...NOVEL_NODE_TYPES],
    relationKinds: [...KG_KINDS_LIST],
    committableNodeTypes: [...COMMITTABLE_BIBLE_NODE_TYPES],
    candidateFamilies: [...BIBLE_CANDIDATE_FAMILIES],
    granularities: [...BIBLE_CANDIDATE_GRANULARITIES],
    evidencePolicy: [
      'Ogni candidato canonico deve indicare evidence.sourceId e evidence.sectionKey verso una bible_section importata.',
      'I claim atomici e i candidati con metadata.granularity=atomic devono includere evidence.textSnippet.',
      'Gli archi canonici devono avere evidence propria; related_to e ammesso solo come fallback da tipizzare.',
      'Gli output editoriali restano draft/proposal e non diventano canone senza commit esplicito.',
    ],
  };
}

function filterCandidateNodesBySectionKeys(candidates: kg.GraphNode[], sectionKeys?: string[]): kg.GraphNode[] {
  const keys = new Set((sectionKeys ?? []).map((key) => key.trim()).filter(Boolean));
  if (!keys.size) return candidates;
  return candidates.filter((candidate) => {
    const evidence = candidate.metadata.evidence;
    if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
      return keys.has(String((evidence as Record<string, unknown>).sectionKey ?? ''));
    }
    const nested = candidate.metadata.candidate;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const nestedEvidence = (nested as Record<string, unknown>).evidence;
      if (nestedEvidence && typeof nestedEvidence === 'object' && !Array.isArray(nestedEvidence)) {
        return keys.has(String((nestedEvidence as Record<string, unknown>).sectionKey ?? ''));
      }
    }
    return false;
  });
}

function metadataBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
}

function evidenceSectionKeyFromUnknown(evidence: unknown, sourceId?: string): string | null {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  const evidenceRecord = evidence as Record<string, unknown>;
  const key = String(evidenceRecord.sectionKey ?? '');
  if (!key) return null;
  if (sourceId && evidenceRecord.sourceId !== sourceId) return null;
  return key;
}

function nodeEvidenceSectionKey(node: kg.GraphNode, sourceId?: string): string | null {
  const evidence = node.metadata.evidence;
  if (Array.isArray(evidence)) {
    for (const item of evidence) {
      const key = evidenceSectionKeyFromUnknown(item, sourceId);
      if (key) return key;
    }
  } else {
    const key = evidenceSectionKeyFromUnknown(evidence, sourceId);
    if (key) return key;
  }
  if (typeof node.provenance.sectionKey === 'string' && (!sourceId || node.provenance.sourceId === sourceId)) return node.provenance.sectionKey;
  if (typeof node.metadata.sectionKey === 'string' && (!sourceId || node.metadata.sourceId === sourceId)) return node.metadata.sectionKey;
  const nested = node.metadata.candidate;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const nestedEvidence = (nested as Record<string, unknown>).evidence;
    const key = evidenceSectionKeyFromUnknown(nestedEvidence, sourceId);
    if (key) return key;
  }
  return null;
}

function nodeMatchesBibleSection(node: kg.GraphNode, sourceId: string, sectionKey: string): boolean {
  return nodeEvidenceSectionKey(node, sourceId) === sectionKey
    || (node.label.startsWith(`${sourceId}::${sectionKey}`) && (node.metadata.sourceId === sourceId || node.provenance.sourceId === sourceId));
}

function classifyParagraphStatus(input: {
  section: kg.GraphNode | null;
  directTextEmpty: boolean;
  pendingCandidates: kg.GraphNode[];
  residualCanonicalClaims: kg.GraphNode[];
}): z.infer<typeof paragraphStatusValueZ> {
  if (!input.section) return 'blocked';
  if (!input.directTextEmpty) return 'content_section';
  if (input.pendingCandidates.length === 0 && input.residualCanonicalClaims.length === 0) return 'header_only';
  return 'requires_claim_cleanup';
}

function isPendingBibleCandidate(candidate: kg.GraphNode): boolean {
  return String(candidate.metadata.status ?? 'pending') === 'pending';
}

function recommendationForParagraph(status: z.infer<typeof paragraphStatusValueZ>): z.infer<typeof bibleParagraphReconciliationPacketZ>['recommendedWorkflowBranch'] {
  if (status === 'content_section') return 'reconcile_candidates';
  if (status === 'requires_claim_cleanup') return 'classify_structural_claims';
  if (status === 'header_only') return 'close_header_only';
  return 'blocked';
}

function structuralClassificationHint(
  claim: kg.GraphNode,
  section: kg.GraphNode | null,
): z.infer<typeof structuralClaimClassificationZ>['classificationHint'] {
  const content = claim.content.trim();
  const sectionKeyValue = section ? String(section.metadata.sectionKey ?? '') : '';
  const heading = section ? String(section.metadata.heading ?? '') : '';
  if (!content) return 'ambiguous';
  if (content === '[Intestazione strutturale dal file sorgente]') return 'structural_noise';
  if (content === `${sectionKeyValue} ${heading}`.trim() || content === `${sectionKeyValue}\t${heading}`.trim()) return 'section_metadata';
  if (heading && content === heading) return 'section_metadata';
  return 'semantic_claim';
}

function structuralClassificationReason(classification: z.infer<typeof structuralClaimClassificationZ>['classificationHint']): string {
  if (classification === 'structural_noise') return 'Il claim contiene solo il marker tecnico di intestazione strutturale.';
  if (classification === 'section_metadata') return 'Il claim duplica numero/titolo della bible_section ed e gia rappresentato dai metadati della sezione.';
  if (classification === 'semantic_claim') return 'Il claim contiene testo oltre la pura intestazione e richiede valutazione semantica.';
  return 'Evidenza insufficiente per classificare il claim.';
}

export async function buildBibleParagraphStatus(sourceId: string, sectionKey: string): Promise<z.infer<typeof bibleParagraphStatusZ>> {
  const normalizedSourceId = sourceId.trim();
  const normalizedSectionKey = sectionKey.trim();
  const section = await kg.getNodeByTypeLabel('bible_section', `${normalizedSourceId}::${normalizedSectionKey}`);
  const [candidatePool, claimPool] = await Promise.all([
    kg.listBibleCandidatesBySection({ sourceId: normalizedSourceId, sectionKey: normalizedSectionKey, limit: 500 }),
    kg.listNodesByTypeBibleSection('bible_claim', { sourceId: normalizedSourceId, sectionKey: normalizedSectionKey, limit: 500 }),
  ]);
  const candidates = candidatePool.filter((candidate) => nodeMatchesBibleSection(candidate, normalizedSourceId, normalizedSectionKey));
  const residualCanonicalClaims = claimPool
    .filter((claim) => claim.metadata.canonStatus === 'canonical')
    .filter((claim) => claim.metadata.requiresReview === true || claim.type === 'bible_claim')
    .filter((claim) => nodeMatchesBibleSection(claim, normalizedSourceId, normalizedSectionKey));
  const directTextEmpty = section ? metadataBoolean(section.metadata.directTextEmpty) : true;
  const pendingCandidates = candidates.filter(isPendingBibleCandidate);
  const workItemsPendingCount = pendingCandidates.length + residualCanonicalClaims.length;
  const paragraphStatus = classifyParagraphStatus({ section, directTextEmpty, pendingCandidates, residualCanonicalClaims });
  const blockingFindings: string[] = [];
  if (!section) blockingFindings.push('missing_bible_section');
  if (pendingCandidates.length > 0) blockingFindings.push('pending_candidates_require_reconciliation');
  if (residualCanonicalClaims.length > 0) blockingFindings.push('residual_canonical_claims_require_review');
  return {
    sourceId: normalizedSourceId,
    sectionKey: normalizedSectionKey,
    paragraphStatus,
    section: section ?? undefined,
    directTextEmpty,
    candidates,
    candidate_pending_count: pendingCandidates.length,
    residualCanonicalClaims,
    residualCanonicalClaims_count: residualCanonicalClaims.length,
    workItemsPending_count: workItemsPendingCount,
    blockingFindings,
  };
}

async function buildParagraphReconciliationPacket(sourceId: string, sectionKey: string): Promise<z.infer<typeof bibleParagraphReconciliationPacketZ>> {
  const paragraph = await buildBibleParagraphStatus(sourceId, sectionKey);
  const section = paragraph.section;
  const childSections = section
    ? await kg.listNodesByTypeLabelPrefix('bible_section', `${paragraph.sourceId}::${paragraph.sectionKey}.`, { limit: 100 })
    : [];
  return {
    ...paragraph,
    sourceText: section?.content ?? '',
    path: Array.isArray(section?.metadata.path) ? section.metadata.path.map(String) : [],
    parentSectionId: typeof section?.metadata.parentSectionId === 'string' ? section.metadata.parentSectionId : undefined,
    childSections,
    ontology: bibleOntologyPacket(),
    recommendedWorkflowBranch: recommendationForParagraph(paragraph.paragraphStatus),
  };
}

function buildStructuralClaimPacketFromParagraph(paragraph: z.infer<typeof bibleParagraphStatusZ>): z.infer<typeof bibleStructuralClaimPacketZ> {
  const section = paragraph.section;
  const classifications = paragraph.residualCanonicalClaims.map((claim) => {
    const classificationHint = structuralClassificationHint(claim, section ?? null);
    return {
      id: claim.id,
      label: claim.label,
      content: claim.content,
      classificationHint,
      reason: structuralClassificationReason(classificationHint),
    };
  });
  return {
    sourceId: paragraph.sourceId,
    sectionKey: paragraph.sectionKey,
    heading: typeof section?.metadata.heading === 'string' ? section.metadata.heading : undefined,
    directTextEmpty: paragraph.directTextEmpty,
    claims: paragraph.residualCanonicalClaims,
    classifications,
    duplicatedSectionMetadata: classifications.some((item) => item.classificationHint === 'section_metadata'),
  };
}

function normalizeForCoverage(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function coverageTerms(value: string): Set<string> {
  return new Set(normalizeForCoverage(value).split(/\s+/).filter((term) => term.length >= 4));
}

function overlapRatio(a: string, b: string): number {
  const aTerms = coverageTerms(a);
  const bTerms = coverageTerms(b);
  if (!aTerms.size || !bTerms.size) return 0;
  let overlap = 0;
  for (const term of aTerms) {
    if (bTerms.has(term)) overlap++;
  }
  return overlap / Math.min(aTerms.size, bTerms.size);
}

function splitAtomicConcepts(content: string): string[] {
  const text = content.trim();
  if (!text) return [];
  const parts = text
    .split(/(?<=[.!?])\s+|;\s+|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [text];
}

function assimilationCoverage(
  concept: string,
  target: kg.GraphNode,
  sourceId: string,
  sectionKey: string,
): { coverage: 'exact' | 'partial' | 'evidence_only'; reason: string } | null {
  const conceptNorm = normalizeForCoverage(concept);
  const targetNorm = normalizeForCoverage(`${target.label} ${target.content}`);
  if (conceptNorm && targetNorm && (targetNorm.includes(conceptNorm) || conceptNorm.includes(targetNorm))) {
    return { coverage: 'exact', reason: 'Il testo del target canonico contiene integralmente il concetto o viceversa.' };
  }
  const ratio = overlapRatio(concept, `${target.label} ${target.content}`);
  if (ratio >= 0.45) {
    return { coverage: 'partial', reason: `Sovrapposizione lessicale significativa con il target canonico: ${ratio.toFixed(2)}.` };
  }
  if (nodeMatchesBibleSection(target, sourceId, sectionKey)) {
    return { coverage: 'evidence_only', reason: 'Il target condivide la stessa evidence section, ma non copre testualmente il concetto.' };
  }
  return null;
}

function isTechnicalOrGenericEdge(edge: kg.GraphEdge): boolean {
  return new Set([
    'related_to',
    'applies_to',
    'approves',
    'revises',
    'supersedes',
    'validates',
    'derived_from',
    'sourced_from',
    'extracted_from',
    'evidenced_by',
    'evidence_for',
    'source_evidence',
    'belongs_to_section',
    'part_of',
  ]).has(edge.kind);
}

function isCanonicalNarrativeEdge(edge: kg.GraphEdge, nodesById: Map<string, kg.GraphNode>): boolean {
  if (isTechnicalOrGenericEdge(edge)) return false;
  const from = nodesById.get(edge.fromId);
  const to = nodesById.get(edge.toId);
  if (!from || !to) return false;
  return !['bible_candidate', 'bible_claim', 'bible_section', 'bible_mapping_batch'].includes(from.type)
    && !['bible_candidate', 'bible_claim', 'bible_section', 'bible_mapping_batch'].includes(to.type);
}

export function isClaimSemanticEdgeRequiringRehome(edge: kg.GraphEdge): boolean {
  return !isTechnicalOrGenericEdge(edge);
}

function incidentEdges(nodeId: string, edges: kg.GraphEdge[]): kg.GraphEdge[] {
  return edges.filter((edge) => edge.fromId === nodeId || edge.toId === nodeId);
}

async function buildClaimAssimilationPacket(
  sourceId: string,
  sectionKey: string,
  claimNodeId: string,
): Promise<z.infer<typeof bibleClaimAssimilationPacketZ>> {
  const normalizedSourceId = sourceId.trim();
  const normalizedSectionKey = sectionKey.trim();
  const normalizedClaimNodeId = claimNodeId.trim();
  const [claimNode, sourceSection] = await Promise.all([
    kg.getNodeById(normalizedClaimNodeId),
    kg.getNodeByTypeLabel('bible_section', `${normalizedSourceId}::${normalizedSectionKey}`),
  ]);
  const blockingFindings: string[] = [];
  const orphanRisk: string[] = [];
  if (!claimNode) blockingFindings.push('missing_claim_node');
  if (claimNode && claimNode.type !== 'bible_claim') blockingFindings.push('claim_node_type_mismatch');
  if (!sourceSection) blockingFindings.push('missing_source_section');
  const sourceSectionMatches = Boolean(claimNode && nodeMatchesBibleSection(claimNode, normalizedSourceId, normalizedSectionKey));
  if (claimNode && !sourceSectionMatches) blockingFindings.push('claim_section_mismatch');

  const sourceText = sourceSection?.content ?? '';
  const claimText = claimNode?.content ?? '';
  const claimTextInSource = Boolean(sourceText.trim() && claimText.trim() && normalizeForCoverage(sourceText).includes(normalizeForCoverage(claimText)));
  const structuralNoiseClaim = Boolean(
    claimNode
    && sourceSection
    && claimNode.type === 'bible_claim'
    && sourceSectionMatches
    && metadataBoolean(sourceSection.metadata.directTextEmpty)
    && structuralClassificationHint(claimNode, sourceSection) === 'structural_noise',
  );
  const atomicConceptTexts = splitAtomicConcepts(claimText);

  const canonicalPool = (await listCanonicalNarrativeNodes(250))
    .filter((node) => node.id !== claimNode?.id)
    .filter((node) => !['bible_candidate', 'bible_section', 'bible_mapping_batch', 'bible_claim'].includes(node.type));

  const candidateTargets = canonicalPool
    .map((node) => {
      const coverages = atomicConceptTexts
        .map((concept) => assimilationCoverage(concept, node, normalizedSourceId, normalizedSectionKey))
        .filter((coverage): coverage is NonNullable<typeof coverage> => Boolean(coverage));
      const best = coverages.find((coverage) => coverage.coverage === 'exact')
        ?? coverages.find((coverage) => coverage.coverage === 'partial')
        ?? coverages.find((coverage) => coverage.coverage === 'evidence_only');
      return { node, best };
    })
    .filter((entry) => entry.best);

  const exactCoverageTargets = candidateTargets.filter((entry) => entry.best?.coverage === 'exact');
  const partialCoverageTargets = candidateTargets.filter((entry) => entry.best?.coverage === 'partial');
  const evidenceOnlyTargets = candidateTargets.filter((entry) => entry.best?.coverage === 'evidence_only');
  const primaryCoverageTargets = exactCoverageTargets.length ? exactCoverageTargets : partialCoverageTargets;
  const secondaryCoverageTargets = exactCoverageTargets.length
    ? [...partialCoverageTargets, ...evidenceOnlyTargets]
    : evidenceOnlyTargets;
  const canonicalPrimaryTargets = primaryCoverageTargets.map((entry) => entry.node).slice(0, 20);
  const canonicalSecondaryTargets = secondaryCoverageTargets.map((entry) => entry.node).slice(0, 20);

  const atomicConcepts = atomicConceptTexts.map((concept, index) => ({
    index,
    text: concept,
    coveredBy: [...canonicalPrimaryTargets, ...canonicalSecondaryTargets].flatMap((target) => {
      const coverage = assimilationCoverage(concept, target, normalizedSourceId, normalizedSectionKey);
      return coverage ? [{ id: target.id, type: target.type, label: target.label, coverage: coverage.coverage, reason: coverage.reason }] : [];
    }),
  }));

  const allAtomicConceptsCovered = atomicConcepts.length > 0
    && atomicConcepts.every((concept) => concept.coveredBy.some((coverage) => coverage.coverage === 'exact' || coverage.coverage === 'partial'));
  if (!structuralNoiseClaim && !allAtomicConceptsCovered) blockingFindings.push('atomic_concepts_not_fully_assimilated');
  if (!structuralNoiseClaim && canonicalPrimaryTargets.length === 0) blockingFindings.push('missing_primary_canonical_target');

  const [claimGraph, ...targetGraphs] = await Promise.all([
    claimNode ? kg.neighbors(claimNode.id, { depth: 1 }) : Promise.resolve({ nodes: [], edges: [] }),
    ...canonicalPrimaryTargets.map((target) => kg.neighbors(target.id, { depth: 1 })),
  ]);
  const targetNeighbors = canonicalPrimaryTargets.map((target, index) => ({
    targetId: target.id,
    nodes: targetGraphs[index]?.nodes ?? [],
    edges: targetGraphs[index]?.edges ?? [],
  }));

  const isolatedTargets = targetNeighbors
    .filter((entry) => {
      const nodesById = new Map(entry.nodes.map((node) => [node.id, node]));
      return incidentEdges(entry.targetId, entry.edges).filter((edge) => isCanonicalNarrativeEdge(edge, nodesById)).length === 0;
    })
    .map((entry) => entry.targetId);
  if (!structuralNoiseClaim && isolatedTargets.length) {
    blockingFindings.push('canonical_target_missing_specialized_navigable_edges');
    orphanRisk.push(`canonical targets without specialized navigable edges: ${isolatedTargets.join(', ')}`);
  }

  const claimSemanticEdges = claimNode
    ? incidentEdges(claimNode.id, claimGraph.edges).filter(isClaimSemanticEdgeRequiringRehome)
    : [];
  if (claimSemanticEdges.length) {
    blockingFindings.push('claim_has_semantic_edges_requiring_rehome_before_delete');
    orphanRisk.push(`claim semantic edges requiring rehome: ${claimSemanticEdges.map((edge) => edge.id).join(', ')}`);
  }

  const requiredPreserveNodeIds = [...new Set([
    sourceSection?.id,
    ...canonicalPrimaryTargets.map((node) => node.id),
    ...canonicalSecondaryTargets.map((node) => node.id),
    ...claimGraph.nodes.filter((node) => node.id !== claimNode?.id && node.type !== 'bible_candidate').map((node) => node.id),
  ].filter((id): id is string => Boolean(id)))];
  const eligible = Boolean(claimNode) && blockingFindings.length === 0;
  const eligibilityReason = eligible && structuralNoiseClaim
    ? 'Il claim residuo e cancellabile: marker tecnico di intestazione strutturale su sezione senza testo diretto; titolo e metadati restano preservati nella bible_section.'
    : eligible
      ? 'Il claim residuo e cancellabile: concetti atomici coperti da target canonici non bible_claim e target connessi da archi specializzati.'
      : `Delete non autorizzabile: ${blockingFindings.join(', ')}`;
  return {
    sourceId: normalizedSourceId,
    sectionKey: normalizedSectionKey,
    claimNodeId: normalizedClaimNodeId,
    claimNode: claimNode ?? undefined,
    sourceSection: sourceSection ?? undefined,
    sourceText,
    atomicConcepts,
    canonicalPrimaryTargets,
    canonicalSecondaryTargets,
    targetNeighbors,
    claimNeighborNodes: claimGraph.nodes,
    claimNeighborEdges: claimGraph.edges,
    evidenceCoverage: {
      sourceSectionMatches,
      claimTextInSource,
      allAtomicConceptsCovered,
    },
    deleteEligibility: {
      eligible,
      reason: eligibilityReason,
      allowedDeleteNodeIds: eligible ? [normalizedClaimNodeId] : [],
      requiredPreserveNodeIds,
    },
    orphanRisk,
    blockingFindings,
  };
}

async function buildValidationPacket(sourceId: string, sectionKey: string): Promise<z.infer<typeof bibleValidationPacketZ>> {
  const paragraph = await buildBibleParagraphStatus(sourceId, sectionKey);
  const checklist = [
    { item: 'section_present', ok: Boolean(paragraph.section), evidence: paragraph.section?.label ?? 'missing' },
    { item: 'candidate_scope_local', ok: true, evidence: `candidate_pending_count=${paragraph.candidate_pending_count}` },
    { item: 'residual_claims_classified_needed', ok: paragraph.residualCanonicalClaims_count === 0 || paragraph.paragraphStatus === 'requires_claim_cleanup', evidence: `residualCanonicalClaims_count=${paragraph.residualCanonicalClaims_count}` },
    { item: 'no_global_coverage_required_for_local_gate', ok: true, evidence: 'paragraph-scoped MCP packet' },
  ];
  const blockingGaps = paragraph.blockingFindings.slice();
  return { sourceId: paragraph.sourceId, sectionKey: paragraph.sectionKey, scope: 'paragraph', paragraph, checklist, blockingGaps };
}

async function buildCandidatePacket(sourceId: string, candidateId: string): Promise<z.infer<typeof bibleCandidatePacketZ>> {
  const candidate = await kg.getBibleCandidateByIdOrLabel(sourceId, candidateId);
  const blockingFindings: string[] = [];
  if (!candidate) blockingFindings.push('missing_bible_candidate');
  const sectionKey = candidate ? nodeEvidenceSectionKey(candidate, sourceId) : null;
  const section = sectionKey ? await kg.getNodeByTypeLabel('bible_section', `${sourceId}::${sectionKey}`) : null;
  if (candidate && !sectionKey) blockingFindings.push('missing_candidate_sectionKey');
  if (sectionKey && !section) blockingFindings.push('missing_candidate_source_section');
  const payload = candidate ? toCandidate(candidate.metadata.candidate ?? {}) : null;
  const targetType = String(candidate?.metadata.targetType ?? payload?.targetType ?? '');
  const label = String(payload?.label ?? '');
  const existing = targetType && label ? await kg.getNodeByTypeLabel(targetType, label) : null;
  const existingCanonicalMatches = existing && existing.metadata.canonStatus === 'canonical' ? [existing] : [];
  const duplicateRisks = existingCanonicalMatches.map((node) => `${node.type}::${node.label}`);
  return {
    sourceId,
    candidateId,
    candidate: candidate ?? undefined,
    section: section ?? undefined,
    sourceSnippet: typeof payload?.evidence?.textSnippet === 'string' ? payload.evidence.textSnippet : undefined,
    existingCanonicalMatches,
    duplicateRisks,
    commitEligibility: {
      eligible: blockingFindings.length === 0,
      blockingFindings,
    },
  };
}

export async function listCanonicalNarrativeNodes(limit?: number): Promise<kg.GraphNode[]> {
  const perTypeLimit = limit ?? 500;
  const groups = await Promise.all(COMMITTABLE_BIBLE_NODE_TYPES.map((type) => kg.listNodesByType(type, { limit: perTypeLimit })));
  return groups.flat().filter((node) => node.metadata.canonStatus === 'canonical');
}

export async function listCoverageFindingsForSource(sourceId?: string, limit?: number): Promise<kg.GraphNode[]> {
  const findings = sourceId
    ? await kg.listNodesByTypeLabelPrefix('bible_coverage_finding', `${sourceId}::`, { limit })
    : await kg.listNodesByType('bible_coverage_finding', { limit: limit ?? 500 });
  return sourceId ? findings.filter((finding) => finding.metadata.sourceId === sourceId) : findings;
}

export async function gatherCoverageEdges(nodes: kg.GraphNode[]): Promise<kg.GraphEdge[]> {
  return kg.edgesForNodeIds(nodes.map((node) => node.id));
}

async function findBibleSection(evidence: BibleCandidate['evidence']): Promise<kg.GraphNode | null> {
  const section = await kg.getNodeByTypeLabel('bible_section', `${evidence.sourceId}::${evidence.sectionKey}`);
  if (!section) return null;
  if (section.metadata.sourceId !== evidence.sourceId || section.metadata.sectionKey !== evidence.sectionKey) return null;
  return section;
}

function candidateEndpointKey(endpoint: { type: string; label: string }): string {
  return `${endpoint.type}::${endpoint.label}`;
}

async function writeExtractedCandidates(sourceId: string, sections: kg.GraphNode[], candidates: BibleCandidate[]): Promise<{
  batch: kg.GraphNode;
  candidateNodes: kg.GraphNode[];
}> {
  const batchWrite = await kg.upsertNode({
    type: 'bible_mapping_batch',
    label: candidateBatchLabel(sourceId, candidates),
    content: `Bible candidate extraction for ${sourceId}`,
    metadata: {
      sourceId,
      candidateCount: candidates.length,
      sectionCount: sections.length,
      canonStatus: 'proposal',
      status: 'pending',
    },
    provenance: { source: 'novel_extract_bible_candidates', sourceId },
  });
  const sectionsByKey = new Map(sections.map((section) => [String(section.metadata.sectionKey ?? ''), section]));
  const candidateNodes: kg.GraphNode[] = [];
  for (const candidate of candidates) {
    const candidateWrite = await kg.upsertNode({
      type: 'bible_candidate',
      label: candidate.candidateId,
      content: candidate.rationale,
      metadata: {
        sourceId,
        status: 'pending',
        candidateKind: candidate.candidateKind,
        targetType: candidate.targetType,
        relationKind: candidate.relationKind,
        evidence: candidate.evidence,
        candidate,
        canonStatus: 'proposal',
      },
      provenance: { source: 'novel_extract_bible_candidates', sourceId, candidateId: candidate.candidateId },
    });
    candidateNodes.push(candidateWrite.node);
    await kg.link({
      fromId: candidateWrite.node.id,
      toId: batchWrite.node.id,
      kind: 'part_of',
      metadata: { sourceId, candidateId: candidate.candidateId },
      provenance: { source: 'novel_extract_bible_candidates', sourceId, candidateId: candidate.candidateId },
    });
    const section = sectionsByKey.get(candidate.evidence.sectionKey);
    if (section) {
      await kg.link({
        fromId: candidateWrite.node.id,
        toId: section.id,
        kind: 'derived_from',
        metadata: { sourceId, sectionKey: candidate.evidence.sectionKey, candidateId: candidate.candidateId },
        provenance: { source: 'novel_extract_bible_candidates', sourceId, candidateId: candidate.candidateId },
      });
    }
  }
  return { batch: batchWrite.node, candidateNodes };
}

async function loadCandidateNode(candidateIdOrNodeId: string): Promise<{ node: kg.GraphNode; candidate: BibleCandidate } | null> {
  const byLabel = await kg.getNodeByTypeLabel('bible_candidate', candidateIdOrNodeId);
  const node = byLabel ?? (await kg.getNodeById(candidateIdOrNodeId));
  if (!node || node.type !== 'bible_candidate') return null;
  const candidate = node.metadata.candidate;
  if (!candidate || typeof candidate !== 'object') throw new Error(`invalid_candidate_node: missing candidate metadata for ${candidateIdOrNodeId}`);
  return { node, candidate: toCandidate(candidate) };
}

async function commitBibleCandidate(
  candidate: BibleCandidate,
  candidateNode?: kg.GraphNode,
  opts: { committedNodeByEndpoint?: Map<string, kg.GraphNode> } = {},
): Promise<{ node?: kg.GraphNode; edge?: kg.GraphEdge }> {
  const section = await findBibleSection(candidate.evidence);
  if (!section) throw new Error(`missing_evidence_section: ${candidate.evidence.sourceId}/${candidate.evidence.sectionKey}`);

  if (candidate.candidateKind === 'node') {
    const written = await kg.upsertNode({
      type: candidate.targetType!,
      label: candidate.label!,
      content: candidate.content ?? candidate.label!,
      metadata: {
        ...(candidate.metadata ?? {}),
        canonStatus: 'canonical',
        committedFromCandidateId: candidate.candidateId,
        evidence: [candidate.evidence],
        sourceId: candidate.evidence.sourceId,
      },
      provenance: {
        source: 'novel_commit_bible_candidates',
        sourceId: candidate.evidence.sourceId,
        sectionKey: candidate.evidence.sectionKey,
        candidateId: candidate.candidateId,
      },
    });
    await kg.link({
      fromId: written.node.id,
      toId: section.id,
      kind: 'derived_from',
      metadata: { sourceId: candidate.evidence.sourceId, sectionKey: candidate.evidence.sectionKey, candidateId: candidate.candidateId },
      provenance: { source: 'novel_commit_bible_candidates', sourceId: candidate.evidence.sourceId, candidateId: candidate.candidateId },
    });
    if (candidateNode) {
      await kg.updateNode(candidateNode.id, { metadata: { status: 'committed', committedNodeId: written.node.id } });
      await kg.link({
        fromId: candidateNode.id,
        toId: written.node.id,
        kind: 'applies_to',
        metadata: { candidateId: candidate.candidateId },
        provenance: { source: 'novel_commit_bible_candidates', sourceId: candidate.evidence.sourceId, candidateId: candidate.candidateId },
      });
    }
    return { node: written.node };
  }

  const from = opts.committedNodeByEndpoint?.get(candidateEndpointKey(candidate.from!)) ?? (await kg.getNodeByTypeLabel(candidate.from!.type, candidate.from!.label));
  const to = opts.committedNodeByEndpoint?.get(candidateEndpointKey(candidate.to!)) ?? (await kg.getNodeByTypeLabel(candidate.to!.type, candidate.to!.label));
  if (!from || !to) throw new Error(`missing_edge_endpoint: ${candidate.candidateId}`);
  const edge = await kg.link({
    fromId: from.id,
    toId: to.id,
    kind: candidate.relationKind!,
    metadata: {
      ...(candidate.metadata ?? {}),
      sourceId: candidate.evidence.sourceId,
      sectionKey: candidate.evidence.sectionKey,
      candidateId: candidate.candidateId,
      evidence: candidate.evidence,
    },
    provenance: { source: 'novel_commit_bible_candidates', sourceId: candidate.evidence.sourceId, candidateId: candidate.candidateId },
  });
  const evidenceWrite = await kg.upsertNode({
    type: 'bible_coverage_finding',
    label: `${candidate.evidence.sourceId}::${candidate.candidateId}::edge-evidence`,
    content: candidate.rationale,
    metadata: {
      sourceId: candidate.evidence.sourceId,
      sectionKey: candidate.evidence.sectionKey,
      candidateId: candidate.candidateId,
      relationKind: candidate.relationKind,
      edgeId: edge.id,
      evidence: candidate.evidence,
      canonStatus: 'canonical',
      findingType: 'edge_evidence',
    },
    provenance: { source: 'novel_commit_bible_candidates', sourceId: candidate.evidence.sourceId, candidateId: candidate.candidateId },
  });
  await kg.link({
    fromId: evidenceWrite.node.id,
    toId: section.id,
    kind: 'derived_from',
    metadata: { sourceId: candidate.evidence.sourceId, sectionKey: candidate.evidence.sectionKey, candidateId: candidate.candidateId, edgeId: edge.id },
    provenance: { source: 'novel_commit_bible_candidates', sourceId: candidate.evidence.sourceId, candidateId: candidate.candidateId },
  });
  await kg.link({
    fromId: evidenceWrite.node.id,
    toId: from.id,
    kind: 'applies_to',
    metadata: { candidateId: candidate.candidateId, edgeId: edge.id, endpoint: 'from' },
    provenance: { source: 'novel_commit_bible_candidates', sourceId: candidate.evidence.sourceId, candidateId: candidate.candidateId },
  });
  await kg.link({
    fromId: evidenceWrite.node.id,
    toId: to.id,
    kind: 'applies_to',
    metadata: { candidateId: candidate.candidateId, edgeId: edge.id, endpoint: 'to' },
    provenance: { source: 'novel_commit_bible_candidates', sourceId: candidate.evidence.sourceId, candidateId: candidate.candidateId },
  });
  if (candidateNode) {
    await kg.updateNode(candidateNode.id, { metadata: { status: 'committed', committedEdgeId: edge.id } });
    await kg.link({
      fromId: candidateNode.id,
      toId: from.id,
      kind: 'applies_to',
      metadata: { candidateId: candidate.candidateId, endpoint: 'from' },
      provenance: { source: 'novel_commit_bible_candidates', sourceId: candidate.evidence.sourceId, candidateId: candidate.candidateId },
    });
    await kg.link({
      fromId: candidateNode.id,
      toId: to.id,
      kind: 'applies_to',
      metadata: { candidateId: candidate.candidateId, endpoint: 'to' },
      provenance: { source: 'novel_commit_bible_candidates', sourceId: candidate.evidence.sourceId, candidateId: candidate.candidateId },
    });
  }
  return { edge };
}

async function missingEdgeEndpointsForBatch(loaded: Array<{ candidate: BibleCandidate }>): Promise<Array<{ candidateId: string; endpoint: 'from' | 'to'; type: string; label: string }>> {
  const plannedNodes = new Set<string>();
  for (const { candidate } of loaded) {
    if (candidate.candidateKind === 'node' && candidate.targetType && candidate.label) {
      plannedNodes.add(candidateEndpointKey({ type: candidate.targetType, label: candidate.label }));
    }
  }

  const missing: Array<{ candidateId: string; endpoint: 'from' | 'to'; type: string; label: string }> = [];
  for (const { candidate } of loaded) {
    if (candidate.candidateKind !== 'edge') continue;
    for (const endpointName of ['from', 'to'] as const) {
      const endpoint = candidate[endpointName];
      if (!endpoint) continue;
      const key = candidateEndpointKey(endpoint);
      if (plannedNodes.has(key)) continue;
      const existing = await kg.getNodeByTypeLabel(endpoint.type, endpoint.label);
      if (!existing) missing.push({ candidateId: candidate.candidateId, endpoint: endpointName, type: endpoint.type, label: endpoint.label });
    }
  }
  return missing;
}

async function missingEvidenceSectionsForBatch(loaded: Array<{ candidate: BibleCandidate }>): Promise<Array<{ candidateId: string; sourceId: string; sectionKey: string }>> {
  const missing: Array<{ candidateId: string; sourceId: string; sectionKey: string }> = [];
  const checked = new Map<string, boolean>();
  for (const { candidate } of loaded) {
    const key = `${candidate.evidence.sourceId}::${candidate.evidence.sectionKey}`;
    let exists = checked.get(key);
    if (exists === undefined) {
      exists = Boolean(await findBibleSection(candidate.evidence));
      checked.set(key, exists);
    }
    if (!exists) {
      missing.push({ candidateId: candidate.candidateId, sourceId: candidate.evidence.sourceId, sectionKey: candidate.evidence.sectionKey });
    }
  }
  return missing;
}

type QueryRecord = { get(key: string): unknown };

function safeRecordJson(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function toNumberValue(value: unknown, fallback = 1): number {
  const maybeNeo4jInt = value as { toNumber?: () => number };
  if (typeof maybeNeo4jInt?.toNumber === 'function') return maybeNeo4jInt.toNumber();
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nodeFromQueryRecord(row: QueryRecord): kg.GraphNode {
  return {
    id: String(row.get('id') ?? ''),
    type: String(row.get('type') ?? ''),
    label: String(row.get('label') ?? ''),
    content: String(row.get('content') ?? ''),
    metadata: safeRecordJson(row.get('metadata')),
    provenance: safeRecordJson(row.get('provenance')),
    createdAt: String(row.get('createdAt') ?? ''),
    updatedAt: String(row.get('updatedAt') ?? ''),
  };
}

function edgeFromQueryRecord(row: QueryRecord): kg.GraphEdge {
  return {
    id: String(row.get('id') ?? ''),
    fromId: String(row.get('fromId') ?? ''),
    toId: String(row.get('toId') ?? ''),
    kind: String(row.get('kind') ?? ''),
    weight: toNumberValue(row.get('weight')),
    metadata: safeRecordJson(row.get('metadata')),
    provenance: safeRecordJson(row.get('provenance')),
    createdAt: String(row.get('createdAt') ?? ''),
  };
}

function isCanonicalNarrativeNode(node: kg.GraphNode): boolean {
  const canonStatus = typeof node.metadata.canonStatus === 'string' ? node.metadata.canonStatus : '';
  return canonStatus === 'canonical' || canonStatus === '';
}

async function loadGlobalCanonicalNarrativeGraph(): Promise<{ nodes: kg.GraphNode[]; edges: kg.GraphEdge[] }> {
  const projectId = config.projectId;
  const nodeRows = await kg.runQuery(`
    MATCH (n:Entity {projectId: $projectId})
    WHERE n.type IN $types
    RETURN n.id AS id,
           n.type AS type,
           n.label AS label,
           n.content AS content,
           n.metadata AS metadata,
           n.provenance AS provenance,
           n.createdAt AS createdAt,
           n.updatedAt AS updatedAt
    ORDER BY n.type, n.label
  `, { projectId, types: [...COMMITTABLE_BIBLE_NODE_TYPES] });

  const nodes = nodeRows.map(nodeFromQueryRecord).filter(isCanonicalNarrativeNode);
  const edgeRows = await kg.runQuery(`
    MATCH (a:Entity {projectId: $projectId})-[r:REL]->(b:Entity {projectId: $projectId})
    RETURN r.id AS id,
           a.id AS fromId,
           b.id AS toId,
           r.kind AS kind,
           r.weight AS weight,
           r.metadata AS metadata,
           r.provenance AS provenance,
           r.createdAt AS createdAt
    ORDER BY r.kind, id
  `, { projectId });

  return { nodes, edges: edgeRows.map(edgeFromQueryRecord) };
}

export function registerNovelBibleTools(server: McpServer): void {
  server.registerTool(
    'novel_ingest_bible_sections',
    {
      title: 'Novel ingest bible sections',
      description: 'Imports complete Bible sections already extracted from DOCX, preserving hierarchy, order, full text, hash and provenance.',
      inputSchema: {
        sourceId: z.string(),
        title: z.string().optional(),
        sections: z.array(bibleSectionInputZ).min(1).max(1000),
      },
      outputSchema: {
        ok: z.boolean(),
        summary: ingestBibleSectionsSummaryZ.optional(),
        root: nodeZ.optional(),
        sections: z.array(nodeZ).optional(),
        plannedSections: z.array(bibleSectionPreviewZ).optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel ingest bible sections', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sourceId, title, sections }) => {
      try {
        const plan = buildBibleSectionsPlan({ sourceId, title, sections });
        const summary = {
          sourceId: plan.sourceId,
          sourceType: plan.sourceType,
          sectionsReceived: sections.length,
          nodesPlanned: plan.sections.length + 1,
          edgesPlanned: plan.edges.length,
          nodesWritten: 0,
          edgesWritten: 0,
        };
        const written = await writeBibleSectionsPlan(plan);
        return toolStructured({
          ok: true,
          summary: { ...summary, nodesWritten: written.nodesWritten, edgesWritten: written.edgesWritten },
          root: written.root,
          sections: written.sections,
          plannedSections: plan.sections.map(previewBibleSection),
        });
      } catch (err) {
        return toolError('NOVEL_INGEST_BIBLE_SECTIONS_FAILED', `novel_ingest_bible_sections failed: ${String(err)}`, { sourceId });
      }
    },
  );

  server.registerTool(
    'novel_extract_bible_candidates',
    {
      title: 'Novel extract bible candidates',
      description: 'Creates non-canonical semantic candidates from imported Bible sections. It never writes final canon.',
      inputSchema: {
        sourceId: z.string(),
        sectionKeys: z.array(z.string()).optional(),
        limit: z.number().int().positive().optional(),
        granularity: z.enum(BIBLE_CANDIDATE_GRANULARITIES).optional(),
        families: z.array(z.enum(BIBLE_CANDIDATE_FAMILIES)).optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        summary: candidateSummaryZ.optional(),
        candidates: z.array(bibleCandidateZ).optional(),
        batch: nodeZ.optional(),
        candidateNodes: z.array(nodeZ).optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel extract bible candidates', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sourceId, sectionKeys, limit, granularity, families }) => {
      try {
        const sections = await listBibleSectionsForExtraction({ sourceId, sectionKeys, limit });
        const candidates = sections.flatMap((section) =>
          extractBibleCandidatesFromSection(section, {
            granularity: granularity as BibleCandidateGranularity | undefined,
            families: families as BibleCandidateFamily[] | undefined,
          }),
        );
        const summary = {
          sourceId,
          sectionsScanned: sections.length,
          candidatesPlanned: candidates.length,
          candidatesWritten: 0,
        };
        const written = await writeExtractedCandidates(sourceId, sections, candidates);
        return toolStructured({
          ok: true,
          summary: { ...summary, candidatesWritten: written.candidateNodes.length },
          candidates,
          batch: written.batch,
          candidateNodes: written.candidateNodes,
        });
      } catch (err) {
        return toolError('NOVEL_EXTRACT_BIBLE_CANDIDATES_FAILED', `novel_extract_bible_candidates failed: ${String(err)}`, { sourceId });
      }
    },
  );

  server.registerTool(
    'novel_commit_bible_candidates',
    {
      title: 'Novel commit bible candidates',
      description: 'Commits only validated Bible candidates into canonical narrative nodes or relations, with mandatory Bible section evidence.',
      inputSchema: {
        candidateIds: z.array(z.string()).optional(),
        candidates: z.array(bibleCandidateZ).optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        summary: candidateSummaryZ.optional(),
        committedNodes: z.array(nodeZ).optional(),
        committedEdges: z.array(z.unknown()).optional(),
        discrepancies: z.array(bibleDiscrepancyZ).optional(),
        errors: z.array(z.object({ candidateId: z.string().optional(), errors: z.array(z.string()) })).optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel commit bible candidates', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ candidateIds, candidates }) => {
      try {
        if (!candidateIds?.length && !candidates?.length) return toolError('NOVEL_COMMIT_CANDIDATES_BAD_INPUT', 'Provide candidateIds or candidates.');
        const loaded: Array<{ node?: kg.GraphNode; candidate: BibleCandidate }> = [];
        for (const candidate of candidates ?? []) loaded.push({ candidate: toCandidate(candidate) });
        for (const candidateId of candidateIds ?? []) {
          const found = await loadCandidateNode(candidateId);
          if (!found) return toolError('NOVEL_COMMIT_CANDIDATES_NOT_FOUND', `Bible candidate not found: ${candidateId}`, { candidateId });
          loaded.push(found);
        }
        const validationErrors = loaded
          .map(({ candidate }) => ({ candidateId: candidate.candidateId, errors: validateBibleCandidateForCommit(candidate) }))
          .filter((entry) => entry.errors.length);
        if (validationErrors.length) {
          return toolError('NOVEL_COMMIT_CANDIDATES_INVALID', 'One or more candidates are invalid.', { errors: validationErrors });
        }
        const summary = {
          sectionsScanned: 0,
          candidatesPlanned: loaded.length,
          candidatesWritten: 0,
          candidatesCommitted: 0,
          edgesCommitted: 0,
        };
        const missingEvidenceSections = await missingEvidenceSectionsForBatch(loaded);
        if (missingEvidenceSections.length) {
          return toolError('NOVEL_COMMIT_CANDIDATES_MISSING_EVIDENCE_SECTIONS', 'One or more candidates reference missing Bible evidence sections.', { missingEvidenceSections });
        }
        const missingEndpoints = await missingEdgeEndpointsForBatch(loaded);
        if (missingEndpoints.length) {
          return toolError('NOVEL_COMMIT_CANDIDATES_MISSING_ENDPOINTS', 'One or more edge candidates reference missing endpoints.', { missingEndpoints });
        }
        const globalGraph = await loadGlobalCanonicalNarrativeGraph();
        const discrepancyReport = buildBibleDiscrepancyReport(
          loaded.map(({ candidate }) => candidate),
          globalGraph.nodes,
          globalGraph.edges,
        );
        if (discrepancyReport.hasBlockingDiscrepancies) {
          return toolError(
            'NOVEL_COMMIT_CANDIDATES_GLOBAL_DISCREPANCIES',
            'One or more candidates conflict with the existing neural model or with the same commit batch.',
            {
              discrepancies: discrepancyReport.discrepancies,
              discrepancySummary: discrepancyReport.summary,
            },
          );
        }
        const committedNodes: kg.GraphNode[] = [];
        const committedEdges: kg.GraphEdge[] = [];
        const committedNodeByEndpoint = new Map<string, kg.GraphNode>();
        for (const item of loaded.filter(({ candidate }) => candidate.candidateKind === 'node')) {
          const committed = await commitBibleCandidate(item.candidate, item.node);
          if (committed.node) {
            committedNodes.push(committed.node);
            committedNodeByEndpoint.set(candidateEndpointKey({ type: item.candidate.targetType!, label: item.candidate.label! }), committed.node);
          }
        }
        for (const item of loaded.filter(({ candidate }) => candidate.candidateKind === 'edge')) {
          const committed = await commitBibleCandidate(item.candidate, item.node, { committedNodeByEndpoint });
          if (committed.edge) committedEdges.push(committed.edge);
        }
        return toolStructured({
          ok: true,
          summary: {
            ...summary,
            candidatesCommitted: committedNodes.length + committedEdges.length,
            edgesCommitted: committedEdges.length,
          },
          committedNodes,
          committedEdges,
          discrepancies: discrepancyReport.discrepancies,
        });
      } catch (err) {
        return toolError('NOVEL_COMMIT_BIBLE_CANDIDATES_FAILED', `novel_commit_bible_candidates failed: ${String(err)}`);
      }
    },
  );

  server.registerTool(
    'novel_get_bible_ontology',
    {
      title: 'Novel get Bible ontology',
      description: 'Read-only ontology packet for Bible mapping agents: node types, relation kinds, committable types, extraction families and evidence policy.',
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        readOnly: z.boolean().optional(),
        ontology: ontologyPacketZ.optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel get Bible ontology', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toolStructured({ ok: true, readOnly: true, ontology: bibleOntologyPacket() }),
  );

  server.registerTool(
    'novel_get_bible_mapping_packet',
    {
      title: 'Novel get Bible mapping packet',
      description: 'Read-only packet for AI-assisted Bible mapping, including source sections, existing candidates, ontology and commit instructions.',
      inputSchema: {
        sourceId: z.string(),
        sectionKeys: z.array(z.string()).optional(),
        limit: z.number().int().positive().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        readOnly: z.boolean().optional(),
        sourceId: z.string().optional(),
        sections: z.array(nodeZ).optional(),
        candidates: z.array(nodeZ).optional(),
        ontology: ontologyPacketZ.optional(),
        instructions: z.array(z.string()).optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel get Bible mapping packet', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sourceId, sectionKeys, limit }) => {
      try {
        const [sections, candidates] = await Promise.all([
          listBibleSectionsForExtraction({ sourceId, sectionKeys, limit }),
          listBibleCandidatesForSource(sourceId, limit),
        ]);
        return toolStructured({
          ok: true,
          readOnly: true,
          sourceId,
          sections,
          candidates: filterCandidateNodesBySectionKeys(candidates, sectionKeys),
          ontology: bibleOntologyPacket(),
          instructions: [
            'Analizza il testo fonte e proponi solo candidati supportati da evidence verso una bible_section.',
            'Usa tipi nodo e archi dell ontology packet; related_to solo se nessuna relazione specifica e corretta.',
            'Per ogni claim atomico inserisci evidence.textSnippet e metadata.granularity=atomic.',
            'Invia i candidati validati a novel_commit_bible_candidates; non trattare il mapping packet come canone.',
          ],
        });
      } catch (err) {
        return toolError('NOVEL_GET_BIBLE_MAPPING_PACKET_FAILED', `novel_get_bible_mapping_packet failed: ${String(err)}`, { sourceId });
      }
    },
  );

  server.registerTool(
    'novel_bible_coverage_report',
    {
      title: 'Novel Bible coverage report',
      description: 'Read-only coverage audit for imported Bible sections, semantic candidates, committed canon and generic relations.',
      inputSchema: {
        sourceId: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        readOnly: z.boolean().optional(),
        report: coverageReportZ.optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel Bible coverage report', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sourceId, limit }) => {
      try {
        const [sections, candidates, canonicalNodes, coverageFindings] = await Promise.all([
          sourceId ? kg.listNodesByTypeLabelPrefix('bible_section', `${sourceId}::`, { limit }) : kg.listNodesByType('bible_section', { limit: limit ?? 500 }),
          listBibleCandidatesForSource(sourceId, limit),
          listCanonicalNarrativeNodes(limit),
          listCoverageFindingsForSource(sourceId, limit),
        ]);
        const coverageEdges = await gatherCoverageEdges(canonicalNodes);
        const report = buildBibleCoverageReport({ sourceId, sections, candidates, canonicalNodes, coverageFindings, edges: coverageEdges });
        return toolStructured({ ok: true, readOnly: true, report });
      } catch (err) {
        return toolError('NOVEL_BIBLE_COVERAGE_REPORT_FAILED', `novel_bible_coverage_report failed: ${String(err)}`, { sourceId });
      }
    },
  );

  server.registerTool(
    'novel_bible_paragraph_status',
    {
      title: 'Novel Bible paragraph status',
      description: 'Read-only paragraph-scoped Bible status: section, local candidates, residual canonical claims and workflow status.',
      inputSchema: {
        sourceId: z.string(),
        sectionKey: z.string(),
      },
      outputSchema: {
        ok: z.boolean(),
        readOnly: z.boolean().optional(),
        status: bibleParagraphStatusZ.optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel Bible paragraph status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sourceId, sectionKey }) => {
      try {
        return toolStructured({ ok: true, readOnly: true, status: await buildBibleParagraphStatus(sourceId, sectionKey) });
      } catch (err) {
        return toolError('NOVEL_BIBLE_PARAGRAPH_STATUS_FAILED', `novel_bible_paragraph_status failed: ${String(err)}`, { sourceId, sectionKey });
      }
    },
  );

  server.registerTool(
    'novel_bible_paragraph_reconciliation_packet',
    {
      title: 'Novel Bible paragraph reconciliation packet',
      description: 'Read-only paragraph packet for reconcilers: local status, source text, child sections and ontology.',
      inputSchema: {
        sourceId: z.string(),
        sectionKey: z.string(),
      },
      outputSchema: {
        ok: z.boolean(),
        readOnly: z.boolean().optional(),
        packet: bibleParagraphReconciliationPacketZ.optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel Bible paragraph reconciliation packet', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sourceId, sectionKey }) => {
      try {
        return toolStructured({ ok: true, readOnly: true, packet: await buildParagraphReconciliationPacket(sourceId, sectionKey) });
      } catch (err) {
        return toolError('NOVEL_BIBLE_PARAGRAPH_RECONCILIATION_PACKET_FAILED', `novel_bible_paragraph_reconciliation_packet failed: ${String(err)}`, { sourceId, sectionKey });
      }
    },
  );

  server.registerTool(
    'novel_bible_structural_claim_packet',
    {
      title: 'Novel Bible structural claim packet',
      description: 'Read-only packet for classifying canonical bible_claim nodes created from structural headings.',
      inputSchema: {
        sourceId: z.string(),
        sectionKey: z.string(),
      },
      outputSchema: {
        ok: z.boolean(),
        readOnly: z.boolean().optional(),
        packet: bibleStructuralClaimPacketZ.optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel Bible structural claim packet', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sourceId, sectionKey }) => {
      try {
        const paragraph = await buildBibleParagraphStatus(sourceId, sectionKey);
        return toolStructured({ ok: true, readOnly: true, packet: buildStructuralClaimPacketFromParagraph(paragraph) });
      } catch (err) {
        return toolError('NOVEL_BIBLE_STRUCTURAL_CLAIM_PACKET_FAILED', `novel_bible_structural_claim_packet failed: ${String(err)}`, { sourceId, sectionKey });
      }
    },
  );

  server.registerTool(
    'novel_bible_claim_assimilation_packet',
    {
      title: 'Novel Bible claim assimilation packet',
      description: 'Read-only proof packet before deleting a residual bible_claim: atomic concept coverage, canonical targets, graph cohesion and orphan risk.',
      inputSchema: {
        sourceId: z.string(),
        sectionKey: z.string(),
        claimNodeId: z.string(),
      },
      outputSchema: {
        ok: z.boolean(),
        readOnly: z.boolean().optional(),
        packet: bibleClaimAssimilationPacketZ.optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel Bible claim assimilation packet', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sourceId, sectionKey, claimNodeId }) => {
      try {
        return toolStructured({ ok: true, readOnly: true, packet: await buildClaimAssimilationPacket(sourceId, sectionKey, claimNodeId) });
      } catch (err) {
        return toolError('NOVEL_BIBLE_CLAIM_ASSIMILATION_PACKET_FAILED', `novel_bible_claim_assimilation_packet failed: ${String(err)}`, { sourceId, sectionKey, claimNodeId });
      }
    },
  );

  server.registerTool(
    'novel_bible_candidate_packet',
    {
      title: 'Novel Bible candidate packet',
      description: 'Read-only packet for one Bible candidate: source section, snippet, existing canonical match and commit eligibility.',
      inputSchema: {
        sourceId: z.string(),
        candidateId: z.string(),
      },
      outputSchema: {
        ok: z.boolean(),
        readOnly: z.boolean().optional(),
        packet: bibleCandidatePacketZ.optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel Bible candidate packet', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sourceId, candidateId }) => {
      try {
        return toolStructured({ ok: true, readOnly: true, packet: await buildCandidatePacket(sourceId, candidateId) });
      } catch (err) {
        return toolError('NOVEL_BIBLE_CANDIDATE_PACKET_FAILED', `novel_bible_candidate_packet failed: ${String(err)}`, { sourceId, candidateId });
      }
    },
  );

  server.registerTool(
    'novel_bible_validation_packet',
    {
      title: 'Novel Bible validation packet',
      description: 'Read-only paragraph-scoped validation packet for gate validators.',
      inputSchema: {
        sourceId: z.string(),
        sectionKey: z.string(),
        scope: z.enum(['paragraph']).optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        readOnly: z.boolean().optional(),
        packet: bibleValidationPacketZ.optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel Bible validation packet', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sourceId, sectionKey }) => {
      try {
        return toolStructured({ ok: true, readOnly: true, packet: await buildValidationPacket(sourceId, sectionKey) });
      } catch (err) {
        return toolError('NOVEL_BIBLE_VALIDATION_PACKET_FAILED', `novel_bible_validation_packet failed: ${String(err)}`, { sourceId, sectionKey });
      }
    },
  );

  server.registerTool(
    'novel_bible_postwrite_status',
    {
      title: 'Novel Bible postwrite status',
      description: 'Read-only postwrite verification packet for one paragraph and explicitly touched nodes.',
      inputSchema: {
        sourceId: z.string(),
        sectionKey: z.string(),
        touchedNodeIds: z.array(z.string()).optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        readOnly: z.boolean().optional(),
        status: biblePostwriteStatusZ.optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel Bible postwrite status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sourceId, sectionKey, touchedNodeIds }) => {
      try {
        const paragraph = await buildBibleParagraphStatus(sourceId, sectionKey);
        const touchedNodes = (await Promise.all((touchedNodeIds ?? []).map((id) => kg.getNodeById(id)))).filter((node): node is kg.GraphNode => Boolean(node));
        const touchedNodeStatuses = await Promise.all((touchedNodeIds ?? []).map(async (id) => {
          const graph = await kg.neighbors(id, { depth: 1 });
          return { id, found: Boolean(touchedNodes.find((node) => node.id === id)), edgeCount: graph.edges.length, genericRelatedToEdges: graph.edges.filter((edge) => edge.kind === 'related_to').length };
        }));
        const blockingFindings = [...paragraph.blockingFindings];
        if (paragraph.candidate_pending_count > 0) blockingFindings.push('candidate_pending_after_write');
        if (paragraph.residualCanonicalClaims_count > 0) blockingFindings.push('residual_canonical_claims_after_write');
        return toolStructured({
          ok: true,
          readOnly: true,
          status: {
            sourceId,
            sectionKey,
            paragraph,
            touchedNodes,
            touchedNodeStatuses,
            paragraphCompletionEligible: blockingFindings.length === 0,
            blockingFindings,
          },
        });
      } catch (err) {
        return toolError('NOVEL_BIBLE_POSTWRITE_STATUS_FAILED', `novel_bible_postwrite_status failed: ${String(err)}`, { sourceId, sectionKey });
      }
    },
  );

  server.registerTool(
    'novel_bible_progress_eligibility',
    {
      title: 'Novel Bible progress eligibility',
      description: 'Read-only decision packet for whether progress.json may advance for one paragraph.',
      inputSchema: {
        sourceId: z.string(),
        sectionKey: z.string(),
      },
      outputSchema: {
        ok: z.boolean(),
        readOnly: z.boolean().optional(),
        eligibility: bibleProgressEligibilityZ.optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel Bible progress eligibility', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sourceId, sectionKey }) => {
      try {
        const paragraph = await buildBibleParagraphStatus(sourceId, sectionKey);
        const blockingFindings = [...paragraph.blockingFindings];
        if (paragraph.candidate_pending_count > 0) blockingFindings.push('pending_candidates_block_progress');
        if (paragraph.residualCanonicalClaims_count > 0) blockingFindings.push('residual_claims_block_progress');
        return toolStructured({
          ok: true,
          readOnly: true,
          eligibility: {
            sourceId,
            sectionKey,
            eligible: blockingFindings.length === 0,
            reason: blockingFindings.length ? 'paragraph_has_blocking_items' : 'paragraph_has_no_local_blockers',
            candidate_pending_count: paragraph.candidate_pending_count,
            residualCanonicalClaims_count: paragraph.residualCanonicalClaims_count,
            workItemsPending_count: paragraph.workItemsPending_count,
            blockingFindings,
            requiredValidators: ['bible-postwrite-verifier', 'galaxy-task-validator'],
          },
        });
      } catch (err) {
        return toolError('NOVEL_BIBLE_PROGRESS_ELIGIBILITY_FAILED', `novel_bible_progress_eligibility failed: ${String(err)}`, { sourceId, sectionKey });
      }
    },
  );

  server.registerTool(
    'novel_bible_checkpoint_summary',
    {
      title: 'Novel Bible checkpoint summary',
      description: 'Read-only lightweight checkpoint summary over a limited sequence of Bible sections.',
      inputSchema: {
        sourceId: z.string(),
        fromSectionKey: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        readOnly: z.boolean().optional(),
        summary: bibleCheckpointSummaryZ.optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel Bible checkpoint summary', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sourceId, fromSectionKey, limit }) => {
      try {
        const sections = await kg.listNodesByTypeLabelPrefix('bible_section', `${sourceId}::`, { limit: limit ?? 25 });
        const ordered = sections
          .sort((a, b) => Number(a.metadata.order ?? 0) - Number(b.metadata.order ?? 0) || a.label.localeCompare(b.label))
          .filter((section) => !fromSectionKey || String(section.metadata.sectionKey ?? '') >= fromSectionKey)
          .slice(0, limit ?? 25);
        const paragraphs = await Promise.all(ordered.map(async (section) => {
          const sectionKey = String(section.metadata.sectionKey ?? section.label.replace(`${sourceId}::`, ''));
          const status = await buildBibleParagraphStatus(sourceId, sectionKey);
          return {
            sectionKey,
            heading: typeof section.metadata.heading === 'string' ? section.metadata.heading : undefined,
            paragraphStatus: status.paragraphStatus,
            candidate_pending_count: status.candidate_pending_count,
            residualCanonicalClaims_count: status.residualCanonicalClaims_count,
            workItemsPending_count: status.workItemsPending_count,
          };
        }));
        return toolStructured({
          ok: true,
          readOnly: true,
          summary: {
            sourceId,
            fromSectionKey,
            paragraphs,
            blockedParagraphs: paragraphs.filter((item) => item.paragraphStatus === 'blocked' || item.paragraphStatus === 'requires_claim_cleanup').map((item) => item.sectionKey),
            globalCoverageRequired: false,
          },
        });
      } catch (err) {
        return toolError('NOVEL_BIBLE_CHECKPOINT_SUMMARY_FAILED', `novel_bible_checkpoint_summary failed: ${String(err)}`, { sourceId, fromSectionKey });
      }
    },
  );

  server.registerTool(
    'novel_get_chapter_context_packet',
    {
      title: 'Novel get chapter context packet',
      description: 'Read-only chapter context packet for editorial agents, based on mapped Bible context, timeline, characters, world rules, style and drafts.',
      inputSchema: {
        task: z.string(),
        chapterNumber: z.number().int().positive(),
        query: z.string().optional(),
        characters: z.array(z.string()).optional(),
        sourceId: z.string().optional(),
        includeDrafts: z.boolean().optional(),
        depth: z.number().int().positive().optional(),
        limit: z.number().int().positive().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        readOnly: z.boolean().optional(),
        packet: z.object({
          task: z.string(),
          chapterNumber: z.number(),
          chapterLabel: z.string(),
          query: z.string(),
          context: contextGroupsZ,
          counts: z.record(z.string(), z.number()),
          coverageWarnings: z.array(coverageFindingZ),
        }).optional(),
        coverage: coverageReportZ.optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel get chapter context packet', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ task, chapterNumber, query, characters, sourceId, includeDrafts, depth, limit }) => {
      try {
        const recallQuery = composeRecallQuery({
          task,
          chapterNumber,
          query: [query, normalizeChapterLabel(chapterNumber), sourceId].filter(Boolean).join(' '),
          characters,
        });
        const [recalled, sections, candidates, canonicalNodes, coverageFindings] = await Promise.all([
          kg.recall(recallQuery, { depth: depth ?? 2, limit: limit ?? 24 }),
          sourceId ? kg.listNodesByTypeLabelPrefix('bible_section', `${sourceId}::`, { limit }) : kg.listNodesByType('bible_section', { limit: limit ?? 500 }),
          listBibleCandidatesForSource(sourceId, limit),
          listCanonicalNarrativeNodes(limit),
          listCoverageFindingsForSource(sourceId, limit),
        ]);
        const coverageEdges = await gatherCoverageEdges(canonicalNodes);
        const coverage = buildBibleCoverageReport({ sourceId, sections, candidates, canonicalNodes, coverageFindings, edges: coverageEdges });
        const packet = buildChapterContextPacket({
          task,
          chapterNumber,
          query: recallQuery,
          nodes: recalled.nodes,
          coverageReport: coverage,
          includeDrafts,
        });
        return toolStructured({ ok: true, readOnly: true, packet, coverage });
      } catch (err) {
        return toolError('NOVEL_GET_CHAPTER_CONTEXT_PACKET_FAILED', `novel_get_chapter_context_packet failed: ${String(err)}`, { task, chapterNumber });
      }
    },
  );
}
