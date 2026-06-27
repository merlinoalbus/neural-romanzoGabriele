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
  const edgeById = new Map<string, kg.GraphEdge>();
  for (const node of nodes) {
    const graph = await kg.neighbors(node.id, { depth: 1 });
    for (const edge of graph.edges) edgeById.set(edge.id, edge);
  }
  return [...edgeById.values()];
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
