/**
 * Real end-to-end smoke test against a live (local, throwaway) Neo4j instance.
 * Not part of the unit test suite — run manually with:
 *   NEO4J_URI=bolt://localhost:7687 NEO4J_USER=neo4j NEO4J_PASSWORD=... PROJECT_ID=e2e-test \
 *   EMBEDDINGS_PROVIDER=openai-compatible EMBEDDINGS_API_KEY=fake-e2e-key \
 *   EMBEDDINGS_MODEL=fake-embed-v1 EMBEDDINGS_BASE_URL=http://127.0.0.1:18797/v1 \
 *   EMBEDDINGS_DIMENSIONS=256 \
 *   node --import tsx scripts/e2e-test.ts
 *
 * Exercises the new chapter pipeline against real Cypher/constraints: session-file lifecycle,
 * candidate extraction/commit with a deliberate contradiction, update-in-place on revision,
 * Prologo/Epilogo coverage, the revision-impact scan (lexical + semantic self-comparison), and
 * the semantic duplicate/review gate against a real (fake-provider-backed) embeddings pipeline.
 *
 * The embeddings provider is a small local HTTP server (fakeEmbeddingsServer.ts), not a real
 * OpenAI-compatible endpoint — no external network or API key is available in this environment.
 * It speaks the exact same request/response contract embedText() expects, so everything except
 * the embedding model's actual semantic quality is exercised for real: HTTP round trip, retry on
 * transient failure, Neo4j vector index creation/query, and the cosine-threshold discrepancy and
 * meaning-shift logic.
 */
import * as kg from '../src/graph/neo4jStore.js';
import { EditingSessionNotFoundError, readEditingSession } from '../src/novel/editingSessionStore.js';
import { embedNodesInline } from '../src/services/embeddingSync.js';
import { registerNovelChapterCandidateTools } from '../src/tools/novelChapterCandidates.js';
import { registerNovelEditingTools } from '../src/tools/novelEditing.js';
import { registerNovelRevisionImpactTools } from '../src/tools/novelRevisionImpact.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startFakeEmbeddingsServer, type FakeEmbeddingsServerHandle } from './fakeEmbeddingsServer.js';

type Handler = (input: unknown) => Promise<{ structuredContent?: Record<string, unknown> }>;

function handlers(server: McpServer): Record<string, Handler> {
  const tools = (server as unknown as { _registeredTools?: Record<string, { handler?: Handler }> })._registeredTools ?? {};
  const out: Record<string, Handler> = {};
  for (const [name, tool] of Object.entries(tools)) if (tool.handler) out[name] = tool.handler;
  return out;
}

async function call(h: Record<string, Handler>, name: string, input: unknown): Promise<Record<string, unknown>> {
  const res = await h[name](input);
  const sc = res.structuredContent ?? {};
  console.log(`\n>> ${name}(${JSON.stringify(input).slice(0, 200)})`);
  console.log(JSON.stringify(sc, null, 2).slice(0, 2000));
  return sc;
}

const FAKE_EMBEDDINGS_PORT = 18797;

const SEMANTIC_CANON_LABEL = 'Alleanza arcana con lo spirito silvano';
const SEMANTIC_CANON_CONTENT =
  'Gabriele ha stretto un patto segreto con lo spirito del bosco antico durante la notte di luna piena, ' +
  'promettendo silenzio eterno in cambio di protezione per la sua famiglia e per il villaggio che lo aveva ' +
  'accolto molti anni prima, quando ancora nessuno conosceva il suo nome ne il segreto che portava nel cuore.';

async function main(): Promise<void> {
  let failures = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) {
      console.log(`  PASS: ${label}`);
    } else {
      failures++;
      console.log(`  FAIL: ${label}`);
    }
  };

  let fakeEmbeddings: FakeEmbeddingsServerHandle | undefined;
  try {
    // --- -1. Fake embeddings provider: first request fails to exercise the retry/backoff path ---
    fakeEmbeddings = await startFakeEmbeddingsServer({ port: FAKE_EMBEDDINGS_PORT, failFirstNRequests: 1 });

    // --- 0. Clean slate: wipe this project's data so repeated runs are deterministic ---
    await kg.runQuery('MATCH (n:Entity {projectId:$pid}) DETACH DELETE n', { pid: process.env.PROJECT_ID ?? 'romanzo-gabriele' });

    const server = new McpServer({ name: 'e2e', version: '1.0.0' });
    registerNovelEditingTools(server);
    registerNovelChapterCandidateTools(server);
    registerNovelRevisionImpactTools(server);
    const h = handlers(server);

    // --- 0.5. Seed the canonical node used to exercise the semantic duplicate/review gate, and
    // embed it through the (deliberately-flaky-once) fake provider to prove retry/backoff works. ---
    const semanticCanon = await kg.upsertNode({
      type: 'secret',
      label: SEMANTIC_CANON_LABEL,
      content: SEMANTIC_CANON_CONTENT,
      metadata: { canonStatus: 'canonical' },
      provenance: { source: 'e2e-seed-semantic' },
    });
    const embedResult = await embedNodesInline([semanticCanon.node.id]);
    check('semantic canon seed embedded despite one simulated transient provider failure', embedResult[0]?.status === 'embedded');
    check('the induced failure was actually retried (2 HTTP requests for 1 embed)', fakeEmbeddings.requestCount === 2);
    const embeddingStatusAfterSeed = await kg.embeddingStatus();
    check('vector index auto-created on first embed (no manual backfill needed)', embeddingStatusAfterSeed.vectorIndexExists === true);

    // --- 1. Seed one canonical fact we will deliberately contradict later ---
    const seededSecret = await kg.upsertNode({
      type: 'secret',
      label: 'Il segreto del ciondolo',
      content: 'Nessuno conosce la vera origine del ciondolo del Nonno.',
      metadata: { canonStatus: 'canonical' },
      provenance: { source: 'e2e-seed' },
    });
    console.log('\n=== Seeded canonical nodes ===', semanticCanon.node.id, seededSecret.node.id);

    // --- 2. Start an editing session for a numbered chapter ---
    const startRes = await call(h, 'novel_start_editing_session', { chapterNumber: 501, title: 'Capitolo di prova E2E' });
    check('session started ok', startRes.ok === true);
    const sessionId = startRes.sessionId as string;
    const chapterNode = startRes.chapter as { id: string; type: string; label: string; metadata: Record<string, unknown> };
    check('chapter node created with type=chapter', chapterNode?.type === 'chapter');
    check('chapter label is "Capitolo 501"', chapterNode?.label === 'Capitolo 501');
    check('chapter canonStatus starts as draft', chapterNode?.metadata.canonStatus === 'draft');

    // --- 3. Extract candidates from synthetic final text (contains a "secret" keyword match) ---
    const chapterText = 'Gabriele nasconde un segreto che nessuno dei suoi amici conosce ancora: il ciondolo del Nonno rivela sempre la verità a chi lo indossa.';
    const extractRes = await call(h, 'novel_extract_chapter_candidates', { chapterNumber: 501, content: chapterText });
    check('extraction ok', extractRes.ok === true);
    const candidates = (extractRes.candidates as Array<Record<string, unknown>>) ?? [];
    check('at least one candidate extracted', candidates.length > 0);
    console.log(`  extracted ${candidates.length} candidate(s):`, candidates.map((c) => `${c.targetType}:${c.label}`));

    // --- 4. Deliberately craft a contradicting candidate and confirm the commit gate blocks it ---
    const contradiction = {
      candidateId: 'e2e-contradiction-1',
      candidateKind: 'node',
      targetType: 'secret',
      label: 'Il segreto del ciondolo',
      content: 'In realtà tutti conoscono benissimo la vera origine del ciondolo del Nonno.',
      evidence: { sourceId: chapterNode.id, sectionKey: 'full', textSnippet: 'tutti conoscono benissimo la vera origine' },
      confidence: 0.9,
      rationale: 'e2e test: deliberate polarity contradiction against the seeded canonical node',
      metadata: {},
    };
    const blockedCommit = await call(h, 'novel_commit_chapter_candidates', { candidates: [contradiction] });
    check('contradicting candidate is BLOCKED', blockedCommit.ok === false);
    check('blocked with the global-discrepancies error code', (blockedCommit.error as { code?: string })?.code === 'NOVEL_COMMIT_CHAPTER_CANDIDATES_GLOBAL_DISCREPANCIES');

    // --- 5. Commit a NON-contradicting candidate and confirm it lands in the graph, linked to the chapter ---
    const goodCandidate = {
      candidateId: 'e2e-goodfact-1',
      candidateKind: 'node',
      targetType: 'artifact',
      label: 'Ciondolo del Nonno (E2E)',
      content: 'Il ciondolo del Nonno rivela sempre la verità a chi lo indossa.',
      evidence: { sourceId: chapterNode.id, sectionKey: 'full', textSnippet: 'il ciondolo del Nonno rivela sempre la verità' },
      confidence: 0.9,
      rationale: 'e2e test: legitimate new fact from the chapter prose',
      metadata: {},
    };
    const goodCommit = await call(h, 'novel_commit_chapter_candidates', { candidates: [goodCandidate] });
    check('legitimate candidate commits successfully', goodCommit.ok === true);
    const committedNodes = (goodCommit.committedNodes as Array<{ id: string; type: string; metadata: Record<string, unknown> }>) ?? [];
    check('exactly one node committed', committedNodes.length === 1);
    check('committed node is canonical', committedNodes[0]?.metadata.canonStatus === 'canonical');
    const derivedEdges = await kg.neighbors(committedNodes[0].id, { depth: 1, kinds: ['derived_from'] });
    check('committed node is linked derived_from the chapter (not orphaned)', derivedEdges.nodes.some((n) => n.id === chapterNode.id));

    // --- 6. Save final chapter TWICE with different content; confirm update-in-place, not stratification ---
    await call(h, 'novel_save_final_chapter', { sessionId, chapterNumber: 501, content: 'Versione finale numero uno del capitolo di prova.' });
    const chapterAfterFirstSave = await kg.getNodeByTypeLabel('chapter', 'Capitolo 501');
    check('chapter canonStatus is canonical after first save', chapterAfterFirstSave?.metadata.canonStatus === 'canonical');
    const firstSaveId = chapterAfterFirstSave?.id;

    // The session file for `sessionId` no longer exists after the save above (deleted). Confirm it
    // directly against the session store rather than through a tool whose `persist` flag is off by
    // default (novel_split_chapter_blocks without persist:true never touches the session file at all).
    let sessionGoneAfterFirstSave = false;
    try {
      await readEditingSession(sessionId);
    } catch (err) {
      sessionGoneAfterFirstSave = err instanceof EditingSessionNotFoundError;
    }
    check('session file was deleted after novel_save_final_chapter', sessionGoneAfterFirstSave);

    // Re-open a session on the SAME chapter to simulate a later revision. Because
    // novel_start_editing_session's sessionId is deterministic on {chapterNumber, title, ...} when
    // no explicit sessionId is passed, resuming with the exact same identifying details reuses the
    // same id — matching the intended idempotent-resume behaviour. Passing a distinct manuscriptId
    // here instead proves a *different* editorial pass gets a genuinely different session file.
    const secondSession = await call(h, 'novel_start_editing_session', { chapterNumber: 501, title: 'Capitolo di prova E2E', manuscriptId: 'e2e-second-pass' });
    const secondSessionId = secondSession.sessionId as string;
    check('a distinct manuscriptId yields a distinct session id from the first pass', secondSessionId !== sessionId);
    await call(h, 'novel_save_final_chapter', {
      sessionId: secondSessionId,
      chapterNumber: 501,
      content: 'Versione finale numero DUE — testo revisionato, stesso capitolo.',
    });
    const chapterAfterSecondSave = await kg.getNodeByTypeLabel('chapter', 'Capitolo 501');
    check('same node id across both final saves (update in place, no stratification)', chapterAfterSecondSave?.id === firstSaveId);
    check('content actually updated to the second save', chapterAfterSecondSave?.content.includes('DUE'));
    const revisionHistory = (chapterAfterSecondSave?.metadata.revisionHistory as unknown[]) ?? [];
    check('revisionHistory accumulated 2 entries (lightweight audit trail)', revisionHistory.length === 2);

    let secondSessionGoneAfterSecondSave = false;
    try {
      await readEditingSession(secondSessionId);
    } catch (err) {
      secondSessionGoneAfterSecondSave = err instanceof EditingSessionNotFoundError;
    }
    check('second session file was also deleted after its own novel_save_final_chapter', secondSessionGoneAfterSecondSave);

    const allChapterNodesNamed501 = await kg.runQuery(
      "MATCH (n:Entity {type:'chapter', label:'Capitolo 501'}) RETURN count(n) AS c",
      {},
    );
    check('exactly ONE chapter node exists for Capitolo 501 (no duplicates)', Number(allChapterNodesNamed501[0]?.get('c')) === 1);

    // --- 7. Prologo coverage: start a session by role instead of chapterNumber ---
    const prologoStart = await call(h, 'novel_start_editing_session', { role: 'prologo', title: 'Prologo di prova E2E' });
    check('Prologo session created ok', prologoStart.ok === true);
    const prologoChapter = prologoStart.chapter as { label: string };
    check('Prologo chapter node has label "Prologo"', prologoChapter?.label === 'Prologo');

    // --- 8. Bad input: neither chapterNumber nor role ---
    const badInput = await call(h, 'novel_start_editing_session', { title: 'no identifier' });
    check('rejects missing chapterNumber/role before touching the graph', badInput.ok === false);

    // --- 9. Revision impact scan: lexical polarity conflict, plus the semantic self-comparison
    // signal for a rewording the lexical dictionary genuinely does not catch, and a minor reword
    // that should NOT be flagged as a meaning shift. ---
    const impactRes = await call(h, 'novel_scan_revision_impact', {
      chapterNumber: 501,
      changedFacts: [
        { nodeId: committedNodes[0].id, newContent: 'Il ciondolo del Nonno in realtà non ha alcun potere.' },
        { nodeId: seededSecret.node.id, newContent: 'Nessuno conosce ancora oggi la vera origine del ciondolo del Nonno.' },
      ],
    });
    check('revision impact scan runs ok', impactRes.ok === true);
    const impacts = (impactRes.impacts as Array<{ directPolarityConflict: boolean; semanticMeaningShift?: { similarity: number; reviewRecommended: boolean } }>) ?? [];
    check('does NOT flag a lexical polarity conflict for this rewording (documents the real gap)', impacts[0]?.directPolarityConflict === false);
    check('DOES flag a semantic meaning shift for the same rewording (the new signal closes the gap)', impacts[0]?.semanticMeaningShift?.reviewRecommended === true);
    check('a minor, meaning-preserving reword is NOT flagged as a semantic meaning shift', impacts[1]?.semanticMeaningShift?.reviewRecommended === false);

    const lexicalConflictRes = await call(h, 'novel_scan_revision_impact', {
      chapterNumber: 501,
      changedFacts: [{ nodeId: seededSecret.node.id, newContent: "Gabriele non conosce affatto l'origine del ciondolo del Nonno." }],
    });
    const lexicalImpacts = (lexicalConflictRes.impacts as Array<{ directPolarityConflict: boolean }>) ?? [];
    check('a wording the lexical dictionary DOES recognize is still flagged (sanity check on the existing lexical path)', lexicalImpacts[0]?.directPolarityConflict === true);

    // --- 10. Semantic gate: near-duplicate candidate (different label, ~same meaning as the
    // seeded canon) must be BLOCKED even though it shares almost no exact wording with the label. ---
    const semanticDuplicateCandidate = {
      candidateId: 'e2e-semantic-duplicate-1',
      candidateKind: 'node',
      targetType: 'secret',
      label: 'Patto segreto del bosco',
      content: SEMANTIC_CANON_CONTENT,
      evidence: { sourceId: chapterNode.id, sectionKey: 'full', textSnippet: 'patto segreto con lo spirito del bosco' },
      confidence: 0.9,
      rationale: 'e2e test: near-duplicate of the seeded semantic canon under a different label',
      metadata: {},
    };
    const semanticDuplicateCommit = await call(h, 'novel_commit_chapter_candidates', { candidates: [semanticDuplicateCandidate] });
    check('semantically near-duplicate candidate is BLOCKED despite a different label', semanticDuplicateCommit.ok === false);
    const semanticDuplicateDiscrepancies = ((semanticDuplicateCommit.error as { details?: { discrepancies?: Array<{ code: string }> } })?.details?.discrepancies) ?? [];
    check('blocked specifically by the semantic duplicate/alias code', semanticDuplicateDiscrepancies.some((d) => d.code === 'possible_duplicate_or_alias_semantic'));

    // --- 11. Semantic gate: review-range candidate (some shared meaning, not a duplicate) commits
    // but surfaces a non-blocking semantic_proximity_review advisory. ---
    const semanticReviewCandidate = {
      candidateId: 'e2e-semantic-review-1',
      candidateKind: 'node',
      targetType: 'secret',
      label: 'Intesa con lo spirito del bosco',
      content:
        'Gabriele ha stretto un patto segreto con lo spirito del bosco millenario durante una tempesta improvvisa, ' +
        'promettendo silenzio eterno in cambio di protezione per la sua gente e per il paese che lo aveva accolto ' +
        'tempo addietro, quando pochi conoscevano il suo nome.',
      evidence: { sourceId: chapterNode.id, sectionKey: 'full', textSnippet: 'intesa con lo spirito del bosco' },
      confidence: 0.9,
      rationale: 'e2e test: semantically close to the seeded canon but not a duplicate',
      metadata: {},
    };
    const semanticReviewCommit = await call(h, 'novel_commit_chapter_candidates', { candidates: [semanticReviewCandidate] });
    check('semantically-close-but-distinct candidate commits (not blocking)', semanticReviewCommit.ok === true);
    const semanticReviewDiscrepancies = (semanticReviewCommit.discrepancies as Array<{ code: string }>) ?? [];
    check('surfaces the non-blocking semantic_proximity_review advisory', semanticReviewDiscrepancies.some((d) => d.code === 'semantic_proximity_review'));

    // --- 12. Semantic gate: an unrelated candidate must commit clean, with no semantic discrepancy. ---
    const semanticUnrelatedCandidate = {
      candidateId: 'e2e-semantic-unrelated-1',
      candidateKind: 'node',
      targetType: 'secret',
      label: 'Voce sussurrata nel mercato',
      content: 'Un mercante racconta di una nave scomparsa al largo di Porto di Sabbia Rossa durante una violenta ondata di caldo estivo.',
      evidence: { sourceId: chapterNode.id, sectionKey: 'full', textSnippet: 'una nave scomparsa al largo' },
      confidence: 0.9,
      rationale: 'e2e test: unrelated fact, must not trip the semantic gate',
      metadata: {},
    };
    const semanticUnrelatedCommit = await call(h, 'novel_commit_chapter_candidates', { candidates: [semanticUnrelatedCandidate] });
    check('unrelated candidate commits clean', semanticUnrelatedCommit.ok === true);
    const semanticUnrelatedDiscrepancies = (semanticUnrelatedCommit.discrepancies as Array<{ code: string }>) ?? [];
    check('no semantic discrepancy raised for genuinely unrelated content', !semanticUnrelatedDiscrepancies.some((d) => d.code.includes('semantic')));

    console.log(`\n=== DONE: ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ===`);
  } finally {
    await fakeEmbeddings?.close();
    await kg.closeDriver();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E SCRIPT CRASHED:', err);
  process.exit(1);
});
