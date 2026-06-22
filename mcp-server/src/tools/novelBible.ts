import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import crypto from 'node:crypto';
import { z } from 'zod';
import * as kg from '../graph/neo4jStore.js';
import {
  extractBibleCandidatesFromSection,
  validateBibleCandidateForCommit,
  type BibleCandidate,
} from '../novel/bibleCandidates.js';
import { buildBibleCoverageReport, buildChapterContextPacket } from '../novel/bibleCoverage.js';
import { buildBibleSectionsPlan, previewBibleSection, type BibleSectionsPlan } from '../novel/bibleSections.js';
import { composeRecallQuery } from '../novel/context.js';
import { normalizeChapterLabel } from '../novel/domain.js';
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
  dryRun: z.boolean(),
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

const candidateEvidenceZ = z.object({
  sourceId: z.string(),
  sectionKey: z.string(),
  sectionLabel: z.string().optional(),
  contentHash: z.string().optional(),
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
  dryRun: z.boolean(),
  sectionsScanned: z.number(),
  candidatesPlanned: z.number(),
  candidatesWritten: z.number(),
  candidatesCommitted: z.number().optional(),
  edgesCommitted: z.number().optional(),
});

const coverageFindingZ = z.object({
  code: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string(),
  evidence: jsonObj.optional(),
});

const coverageReportZ = z.object({
  sourceId: z.string().optional(),
  sectionCount: z.number(),
  mappedSections: z.number(),
  unmappedSections: z.array(z.object({ sectionKey: z.string(), label: z.string(), heading: z.string().optional(), order: z.number().optional() })),
  pendingCandidates: z.number(),
  nodesWithoutEvidence: z.array(z.object({ id: z.string(), type: z.string(), label: z.string() })),
  genericRelatedToEdges: z.number(),
  findings: z.array(coverageFindingZ),
});

const contextGroupsZ = z.object({
  chapters: z.array(nodeZ),
  drafts: z.array(nodeZ),
  characters: z.array(nodeZ),
  characterVoices: z.array(nodeZ),
  relationshipDynamics: z.array(nodeZ),
  themes: z.array(nodeZ),
  locations: z.array(nodeZ),
  worldRules: z.array(nodeZ),
  styleRules: z.array(nodeZ),
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

async function listBibleSectionsForExtraction(input: { sourceId: string; sectionKeys?: string[]; limit?: number }): Promise<kg.GraphNode[]> {
  const keys = new Set((input.sectionKeys ?? []).map((key) => key.trim()).filter(Boolean));
  if (keys.size) {
    const sections = await Promise.all([...keys].map((key) => kg.getNodeByTypeLabel('bible_section', `${input.sourceId}::${key}`)));
    return sections.filter((section): section is kg.GraphNode =>
      Boolean(section && section.metadata.sourceId === input.sourceId && keys.has(String(section.metadata.sectionKey ?? ''))),
    );
  }
  return kg.listNodesByTypeLabelPrefix('bible_section', `${input.sourceId}::`, { limit: input.limit });
}

async function listBibleCandidatesForSource(sourceId?: string, limit?: number): Promise<kg.GraphNode[]> {
  const candidates = await kg.listNodesByType('bible_candidate', { limit: limit ?? 500 });
  return sourceId ? candidates.filter((candidate) => candidate.metadata.sourceId === sourceId) : candidates;
}

async function listCanonicalNarrativeNodes(limit?: number): Promise<kg.GraphNode[]> {
  const types = [
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
  ];
  const perTypeLimit = limit ?? 500;
  const groups = await Promise.all(types.map((type) => kg.listNodesByType(type, { limit: perTypeLimit })));
  return groups.flat().filter((node) => node.metadata.canonStatus === 'canonical');
}

async function listCoverageFindingsForSource(sourceId?: string, limit?: number): Promise<kg.GraphNode[]> {
  const findings = sourceId
    ? await kg.listNodesByTypeLabelPrefix('bible_coverage_finding', `${sourceId}::`, { limit })
    : await kg.listNodesByType('bible_coverage_finding', { limit: limit ?? 500 });
  return sourceId ? findings.filter((finding) => finding.metadata.sourceId === sourceId) : findings;
}

async function gatherCoverageEdges(nodes: kg.GraphNode[]): Promise<kg.GraphEdge[]> {
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

async function commitBibleCandidate(candidate: BibleCandidate, candidateNode?: kg.GraphNode): Promise<{ node?: kg.GraphNode; edge?: kg.GraphEdge }> {
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

  const from = await kg.getNodeByTypeLabel(candidate.from!.type, candidate.from!.label);
  const to = await kg.getNodeByTypeLabel(candidate.to!.type, candidate.to!.label);
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
        dryRun: z.boolean().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        dryRun: z.boolean().optional(),
        summary: ingestBibleSectionsSummaryZ.optional(),
        root: nodeZ.optional(),
        sections: z.array(nodeZ).optional(),
        plannedSections: z.array(bibleSectionPreviewZ).optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel ingest bible sections', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sourceId, title, sections, dryRun }) => {
      try {
        const plan = buildBibleSectionsPlan({ sourceId, title, sections });
        const summary = {
          sourceId: plan.sourceId,
          sourceType: plan.sourceType,
          dryRun: Boolean(dryRun),
          sectionsReceived: sections.length,
          nodesPlanned: plan.sections.length + 1,
          edgesPlanned: plan.edges.length,
          nodesWritten: 0,
          edgesWritten: 0,
        };
        if (dryRun) {
          return toolStructured({
            ok: true,
            dryRun: true,
            summary,
            plannedSections: plan.sections.map(previewBibleSection),
          });
        }
        const written = await writeBibleSectionsPlan(plan);
        return toolStructured({
          ok: true,
          dryRun: false,
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
        dryRun: z.boolean().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        dryRun: z.boolean().optional(),
        summary: candidateSummaryZ.optional(),
        candidates: z.array(bibleCandidateZ).optional(),
        batch: nodeZ.optional(),
        candidateNodes: z.array(nodeZ).optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel extract bible candidates', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sourceId, sectionKeys, limit, dryRun }) => {
      try {
        const sections = await listBibleSectionsForExtraction({ sourceId, sectionKeys, limit });
        const candidates = sections.flatMap((section) => extractBibleCandidatesFromSection(section));
        const summary = {
          sourceId,
          dryRun: Boolean(dryRun),
          sectionsScanned: sections.length,
          candidatesPlanned: candidates.length,
          candidatesWritten: 0,
        };
        if (dryRun) return toolStructured({ ok: true, dryRun: true, summary, candidates });
        const written = await writeExtractedCandidates(sourceId, sections, candidates);
        return toolStructured({
          ok: true,
          dryRun: false,
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
        dryRun: z.boolean().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        dryRun: z.boolean().optional(),
        summary: candidateSummaryZ.optional(),
        committedNodes: z.array(nodeZ).optional(),
        committedEdges: z.array(z.unknown()).optional(),
        errors: z.array(z.object({ candidateId: z.string().optional(), errors: z.array(z.string()) })).optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel commit bible candidates', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ candidateIds, candidates, dryRun }) => {
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
          dryRun: Boolean(dryRun),
          sectionsScanned: 0,
          candidatesPlanned: loaded.length,
          candidatesWritten: 0,
          candidatesCommitted: 0,
          edgesCommitted: 0,
        };
        if (dryRun) return toolStructured({ ok: true, dryRun: true, summary });
        const committedNodes: kg.GraphNode[] = [];
        const committedEdges: kg.GraphEdge[] = [];
        for (const item of loaded) {
          const committed = await commitBibleCandidate(item.candidate, item.node);
          if (committed.node) committedNodes.push(committed.node);
          if (committed.edge) committedEdges.push(committed.edge);
        }
        return toolStructured({
          ok: true,
          dryRun: false,
          summary: {
            ...summary,
            candidatesCommitted: committedNodes.length,
            edgesCommitted: committedEdges.length,
          },
          committedNodes,
          committedEdges,
        });
      } catch (err) {
        return toolError('NOVEL_COMMIT_BIBLE_CANDIDATES_FAILED', `novel_commit_bible_candidates failed: ${String(err)}`);
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
