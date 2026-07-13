import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as kg from '../graph/neo4jStore.js';
import {
  validateContentCandidateForCommit,
  type ContentCandidate,
} from '../novel/bibleCandidates.js';
import { buildCanonDiscrepancyReport } from '../novel/bibleDiscrepancy.js';
import { extractChapterCandidates } from '../novel/chapterCandidates.js';
import { CHAPTER_SECTION_ROLES, resolveChapterSectionLabel } from '../novel/domain.js';
import { embedNodesInline, semanticDiscrepancyOptionsIfConfigured } from '../services/embeddingSync.js';
import { loadGlobalCanonicalNarrativeGraph, missingEdgeEndpointsForBatch } from './novelBible.js';
import { errorObj, toolError, toolStructured } from './responseHelpers.js';

/**
 * The chapter counterpart of novelBible.ts's candidate pipeline — but a single-pass one, not an
 * incremental one. A chapter enters the graph once, already in its final form (per explicit
 * product decision): there is no multi-session backlog to reconcile, so candidates never become
 * graph nodes. They flow as plain data from `novel_extract_chapter_candidates` to
 * `novel_commit_chapter_candidates`, validated SOLELY against the rest of the already-consolidated
 * canon (Bible + previously canonized chapters) — never against a prior draft of the same chapter,
 * since none ever persists.
 */

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

const candidateEndpointZ = z.object({ type: z.string(), label: z.string() });

const candidateEvidenceZ = z.object({
  sourceId: z.string(),
  sectionKey: z.string(),
  sectionLabel: z.string().optional(),
  contentHash: z.string().optional(),
  path: z.array(z.string()).optional(),
  span: z.object({
    startChar: z.number().int().nonnegative().optional(),
    endChar: z.number().int().nonnegative().optional(),
    paragraphIndex: z.number().int().nonnegative().optional(),
  }).optional(),
  textSnippet: z.string().optional(),
});

const contentCandidateZ = z.object({
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

const discrepancyZ = z.object({
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

function toCandidate(value: unknown): ContentCandidate {
  return value as ContentCandidate;
}

const chapterIdentifierShape = {
  chapterNumber: z.number().int().positive().optional(),
  role: z.enum(CHAPTER_SECTION_ROLES).optional(),
};

async function resolveChapterNode(identifier: { chapterNumber?: number; role?: 'prologo' | 'epilogo' }): Promise<kg.GraphNode> {
  const label = resolveChapterSectionLabel(identifier);
  const node = identifier.chapterNumber === undefined
    ? await kg.getNodeByTypeLabel('chapter', label)
    : await kg.getChapterByNumber(identifier.chapterNumber);
  if (!node) throw new Error(`chapter_not_found: ${label}. Start an editing session or ingest a draft first so a chapter node exists.`);
  return node;
}

async function missingEvidenceChaptersForBatch(loaded: Array<{ candidate: ContentCandidate }>): Promise<Array<{ candidateId: string; sourceId: string }>> {
  const missing: Array<{ candidateId: string; sourceId: string }> = [];
  const checked = new Map<string, boolean>();
  for (const { candidate } of loaded) {
    const sourceId = candidate.evidence.sourceId;
    let exists = checked.get(sourceId);
    if (exists === undefined) {
      const node = await kg.getNodeById(sourceId);
      exists = Boolean(node && node.type === 'chapter');
      checked.set(sourceId, exists);
    }
    if (!exists) missing.push({ candidateId: candidate.candidateId, sourceId });
  }
  return missing;
}

function endpointKey(endpoint: { type: string; label: string }): string {
  return `${endpoint.type}::${endpoint.label}`;
}

async function commitChapterCandidateNode(candidate: ContentCandidate): Promise<kg.GraphNode> {
  const chapter = await kg.getNodeById(candidate.evidence.sourceId);
  if (!chapter || chapter.type !== 'chapter') throw new Error(`missing_evidence_chapter: ${candidate.evidence.sourceId}`);
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
      source: 'novel_commit_chapter_candidates',
      sourceId: candidate.evidence.sourceId,
      sectionKey: candidate.evidence.sectionKey,
      candidateId: candidate.candidateId,
    },
  });
  await kg.link({
    fromId: written.node.id,
    toId: chapter.id,
    kind: 'derived_from',
    metadata: { sourceId: candidate.evidence.sourceId, sectionKey: candidate.evidence.sectionKey, candidateId: candidate.candidateId },
    provenance: { source: 'novel_commit_chapter_candidates', sourceId: candidate.evidence.sourceId, candidateId: candidate.candidateId },
  });
  return written.node;
}

async function commitChapterCandidateEdge(candidate: ContentCandidate, committedNodeByEndpoint: Map<string, kg.GraphNode>): Promise<kg.GraphEdge> {
  const from = committedNodeByEndpoint.get(endpointKey(candidate.from!)) ?? (await kg.getNodeByTypeLabel(candidate.from!.type, candidate.from!.label));
  const to = committedNodeByEndpoint.get(endpointKey(candidate.to!)) ?? (await kg.getNodeByTypeLabel(candidate.to!.type, candidate.to!.label));
  if (!from || !to) throw new Error(`missing_edge_endpoint: ${candidate.candidateId}`);
  return kg.link({
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
    provenance: { source: 'novel_commit_chapter_candidates', sourceId: candidate.evidence.sourceId, candidateId: candidate.candidateId },
  });
}

export function registerNovelChapterCandidateTools(server: McpServer): void {
  server.registerTool(
    'novel_extract_chapter_candidates',
    {
      title: 'Novel extract chapter candidates',
      description:
        'Extracts structured, evidence-anchored candidates from the FINAL text of a chapter, Prologo or Epilogo (or one of its editorial blocks). Returns them as data only — never persisted as graph nodes, since a chapter is committed once, in one pass.',
      inputSchema: {
        ...chapterIdentifierShape,
        content: z.string(),
        blockLabel: z.string().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        candidates: z.array(contentCandidateZ).optional(),
        summary: z.object({ chapterNumber: z.number().optional(), role: z.enum(CHAPTER_SECTION_ROLES).optional(), sectionKey: z.string(), candidatesExtracted: z.number() }).optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel extract chapter candidates', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ chapterNumber, role, content, blockLabel }) => {
      try {
        if (chapterNumber === undefined && !role) {
          return toolError('NOVEL_EXTRACT_CHAPTER_CANDIDATES_BAD_INPUT', 'Provide chapterNumber (numbered chapter) or role (prologo/epilogo).');
        }
        if (!content.trim()) return toolError('NOVEL_EXTRACT_CHAPTER_CANDIDATES_BAD_INPUT', 'content is required', { chapterNumber, role });
        const chapter = await resolveChapterNode({ chapterNumber, role });
        const sectionKey = blockLabel?.trim() || 'full';
        const candidates = extractChapterCandidates({ sourceId: chapter.id, label: chapter.label, content, sectionKey });
        return toolStructured({
          ok: true,
          candidates,
          summary: { chapterNumber, role, sectionKey, candidatesExtracted: candidates.length },
        });
      } catch (err) {
        return toolError('NOVEL_EXTRACT_CHAPTER_CANDIDATES_FAILED', `novel_extract_chapter_candidates failed: ${String(err)}`, { chapterNumber, role });
      }
    },
  );

  server.registerTool(
    'novel_commit_chapter_candidates',
    {
      title: 'Novel commit chapter candidates',
      description:
        'Commits validated chapter-derived candidates as canonical nodes/edges. Validates each candidate SOLELY against the rest of the already-consolidated canon (Bible + previously canonized chapters) — never against a prior draft of the same chapter, since none persist. Candidates are plain input data: nothing scaffolding is ever written or needs cleanup.',
      inputSchema: {
        candidates: z.array(contentCandidateZ).min(1).max(500),
      },
      outputSchema: {
        ok: z.boolean(),
        summary: z.object({ candidatesCommitted: z.number(), nodesCommitted: z.number(), edgesCommitted: z.number() }).optional(),
        committedNodes: z.array(nodeZ).optional(),
        committedEdges: z.array(z.unknown()).optional(),
        discrepancies: z.array(discrepancyZ).optional(),
        errors: z.array(z.object({ candidateId: z.string().optional(), errors: z.array(z.string()) })).optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel commit chapter candidates', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ candidates }) => {
      try {
        const loaded = candidates.map((candidate) => ({ candidate: toCandidate(candidate) }));

        const validationErrors = loaded
          .map(({ candidate }) => ({ candidateId: candidate.candidateId, errors: validateContentCandidateForCommit(candidate) }))
          .filter((entry) => entry.errors.length);
        if (validationErrors.length) {
          return toolError('NOVEL_COMMIT_CHAPTER_CANDIDATES_INVALID', 'One or more candidates are invalid.', { errors: validationErrors });
        }

        const missingEvidenceChapters = await missingEvidenceChaptersForBatch(loaded);
        if (missingEvidenceChapters.length) {
          return toolError('NOVEL_COMMIT_CHAPTER_CANDIDATES_MISSING_EVIDENCE_CHAPTER', 'One or more candidates reference a chapter that does not exist yet.', { missingEvidenceChapters });
        }

        const missingEndpoints = await missingEdgeEndpointsForBatch(loaded);
        if (missingEndpoints.length) {
          return toolError('NOVEL_COMMIT_CHAPTER_CANDIDATES_MISSING_ENDPOINTS', 'One or more edge candidates reference missing endpoints.', { missingEndpoints });
        }

        const globalGraph = await loadGlobalCanonicalNarrativeGraph();
        const discrepancyReport = await buildCanonDiscrepancyReport(
          loaded.map(({ candidate }) => candidate),
          globalGraph.nodes,
          globalGraph.edges,
          semanticDiscrepancyOptionsIfConfigured(),
        );
        if (discrepancyReport.hasBlockingDiscrepancies) {
          return toolError(
            'NOVEL_COMMIT_CHAPTER_CANDIDATES_GLOBAL_DISCREPANCIES',
            'One or more candidates conflict with the rest of the consolidated canon.',
            { discrepancies: discrepancyReport.discrepancies, discrepancySummary: discrepancyReport.summary },
          );
        }

        const committedNodes: kg.GraphNode[] = [];
        const committedEdges: kg.GraphEdge[] = [];
        const committedNodeByEndpoint = new Map<string, kg.GraphNode>();
        for (const item of loaded.filter(({ candidate }) => candidate.candidateKind === 'node')) {
          const node = await commitChapterCandidateNode(item.candidate);
          committedNodes.push(node);
          committedNodeByEndpoint.set(endpointKey({ type: item.candidate.targetType!, label: item.candidate.label! }), node);
        }
        for (const item of loaded.filter(({ candidate }) => candidate.candidateKind === 'edge')) {
          committedEdges.push(await commitChapterCandidateEdge(item.candidate, committedNodeByEndpoint));
        }
        await embedNodesInline(committedNodes.map((node) => node.id));

        return toolStructured({
          ok: true,
          summary: {
            candidatesCommitted: committedNodes.length + committedEdges.length,
            nodesCommitted: committedNodes.length,
            edgesCommitted: committedEdges.length,
          },
          committedNodes,
          committedEdges,
          discrepancies: discrepancyReport.discrepancies,
        });
      } catch (err) {
        return toolError('NOVEL_COMMIT_CHAPTER_CANDIDATES_FAILED', `novel_commit_chapter_candidates failed: ${String(err)}`);
      }
    },
  );

  server.registerTool(
    'novel_chapter_candidate_packet',
    {
      title: 'Novel chapter candidate packet',
      description: 'Read-only inspection packet for a single not-yet-committed chapter candidate: the exact-match canonical node if one exists, plus the nearest semantic match when embeddings are configured.',
      inputSchema: { candidate: contentCandidateZ },
      outputSchema: {
        ok: z.boolean(),
        exactMatch: nodeZ.optional(),
        nearestSemanticMatch: z.object({ node: nodeZ, score: z.number() }).optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel chapter candidate packet', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ candidate }) => {
      try {
        const typed = toCandidate(candidate);
        const exactMatch = typed.targetType && typed.label ? await kg.getNodeByTypeLabel(typed.targetType, typed.label) : null;
        const semantic = semanticDiscrepancyOptionsIfConfigured();
        let nearestSemanticMatch: { node: kg.GraphNode; score: number } | undefined;
        if (semantic && typed.targetType) {
          const text = [typed.label, typed.content].filter(Boolean).join('\n').trim();
          if (text) {
            const vector = await semantic.embedText(text);
            const matches = await semantic.semanticSearch(vector, { type: typed.targetType, limit: 1 });
            if (matches[0]) nearestSemanticMatch = matches[0];
          }
        }
        return toolStructured({ ok: true, exactMatch: exactMatch ?? undefined, nearestSemanticMatch });
      } catch (err) {
        return toolError('NOVEL_CHAPTER_CANDIDATE_PACKET_FAILED', `novel_chapter_candidate_packet failed: ${String(err)}`);
      }
    },
  );

  server.registerTool(
    'novel_chapter_validation_packet',
    {
      title: 'Novel chapter validation packet',
      description: 'Read-only: runs the full lexical+semantic discrepancy check for a batch of not-yet-committed chapter candidates against the rest of canon, without writing anything. Lets a validator agent double-check the gate independently before or after novel_commit_chapter_candidates.',
      inputSchema: { candidates: z.array(contentCandidateZ).min(1).max(500) },
      outputSchema: {
        ok: z.boolean(),
        validationErrors: z.array(z.object({ candidateId: z.string(), errors: z.array(z.string()) })).optional(),
        discrepancies: z.array(discrepancyZ).optional(),
        summary: z.object({
          checkedCandidates: z.number(),
          checkedCanonicalNodes: z.number(),
          checkedCanonicalEdges: z.number(),
          errors: z.number(),
          warnings: z.number(),
          info: z.number(),
          blocking: z.number(),
        }).optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel chapter validation packet', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ candidates }) => {
      try {
        const loaded = candidates.map((candidate) => toCandidate(candidate));
        const validationErrors = loaded
          .map((candidate) => ({ candidateId: candidate.candidateId, errors: validateContentCandidateForCommit(candidate) }))
          .filter((entry) => entry.errors.length);
        const globalGraph = await loadGlobalCanonicalNarrativeGraph();
        const discrepancyReport = await buildCanonDiscrepancyReport(loaded, globalGraph.nodes, globalGraph.edges, semanticDiscrepancyOptionsIfConfigured());
        return toolStructured({
          ok: !validationErrors.length && !discrepancyReport.hasBlockingDiscrepancies,
          validationErrors,
          discrepancies: discrepancyReport.discrepancies,
          summary: discrepancyReport.summary,
        });
      } catch (err) {
        return toolError('NOVEL_CHAPTER_VALIDATION_PACKET_FAILED', `novel_chapter_validation_packet failed: ${String(err)}`);
      }
    },
  );

  server.registerTool(
    'novel_chapter_postwrite_status',
    {
      title: 'Novel chapter postwrite status',
      description: 'Read-only post-commit check: confirms each given node id exists, is canonical, and is not orphaned (has at least one edge) after a novel_commit_chapter_candidates call.',
      inputSchema: {
        ...chapterIdentifierShape,
        nodeIds: z.array(z.string()).default([]),
      },
      outputSchema: {
        ok: z.boolean(),
        chapter: nodeZ.optional(),
        nodes: z.array(z.object({ id: z.string(), exists: z.boolean(), canonical: z.boolean(), hasEdges: z.boolean() })).optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel chapter postwrite status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ chapterNumber, role, nodeIds }) => {
      try {
        if (chapterNumber === undefined && !role) {
          return toolError('NOVEL_CHAPTER_POSTWRITE_STATUS_BAD_INPUT', 'Provide chapterNumber (numbered chapter) or role (prologo/epilogo).');
        }
        const chapter = await resolveChapterNode({ chapterNumber, role });
        const nodes = [];
        for (const id of nodeIds) {
          const node = await kg.getNodeById(id);
          const expanded = node ? await kg.neighbors(id, { depth: 1 }) : null;
          nodes.push({
            id,
            exists: Boolean(node),
            canonical: node?.metadata.canonStatus === 'canonical',
            hasEdges: Boolean(expanded?.edges.length),
          });
        }
        return toolStructured({ ok: true, chapter, nodes });
      } catch (err) {
        return toolError('NOVEL_CHAPTER_POSTWRITE_STATUS_FAILED', `novel_chapter_postwrite_status failed: ${String(err)}`, { chapterNumber, role });
      }
    },
  );
}
