import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { Activity, BookOpen, Clock, Database, Download, FileText, GitBranch, Globe2, ListChecks, Network, PenLine, RefreshCw, ScrollText, Search, ShieldCheck, Upload, Users, X } from 'lucide-react';
import {
  commitGraphSnapshotImport,
  dryRunGraphSnapshotImport,
  exportGraphSnapshot,
  getChapterPacket,
  getEntityPacket,
  getHealth,
  getKgNeighbors,
  getKgNode,
  getKgStats,
  getTimeline,
  listChapters,
  listKgDocuments,
  listKgNodes,
  listKgOpenPoints,
  searchKg,
  type ChapterPacket,
  type ChapterSummary,
  type EntityPacket,
  type GraphSnapshot,
  type HealthReport,
  type ImportMode,
  type KgEdge,
  type KgNode,
  type KgStats,
  type OpenPoint,
  type SnapshotImportResult,
  type TimelineEntry,
} from './api';

const TYPE_COLORS: Record<string, string> = {
  bible_outline: '#6d28d9',
  bible_section: '#7c3aed',
  chapter: '#dc2626',
  chapter_draft: '#f97316',
  character: '#16a34a',
  character_state: '#65a30d',
  character_voice: '#0d9488',
  continuity_finding: '#b91c1c',
  document: '#2563eb',
  chunk: '#64748b',
  foreshadowing: '#9333ea',
  glossary_term: '#0891b2',
  location: '#d97706',
  organization: '#db2777',
  event: '#ef4444',
  plot_thread: '#be123c',
  relationship_dynamic: '#059669',
  scene: '#f59e0b',
  style_rule: '#4f46e5',
  theme: '#8b5cf6',
  timeline_event: '#ea580c',
  world_rule: '#0369a1',
  concept: '#7c3aed',
  procedure: '#0891b2',
  decision: '#4f46e5',
  ticket: '#ea580c',
  thread: '#0d9488',
  note: '#475569',
};

const TYPE_LABELS: Record<string, string> = {
  bible_outline: 'indice bibbia',
  bible_section: 'sezione',
  chapter: 'capitolo',
  chapter_draft: 'bozza',
  character: 'personaggio',
  character_state: 'stato personaggio',
  character_voice: 'voce',
  continuity_finding: 'rilievo coerenza',
  document: 'documento',
  chunk: 'frammento',
  foreshadowing: 'semina narrativa',
  glossary_term: 'glossario',
  location: 'luogo',
  plot_thread: 'filo narrativo',
  relationship_dynamic: 'relazione',
  scene: 'scena',
  style_rule: 'regola stile',
  theme: 'tema',
  timeline_event: 'evento timeline',
  world_rule: 'regola mondo',
};

const colorFor = (type: string): string => TYPE_COLORS[type] ?? '#334155';
const labelFor = (type: string): string => TYPE_LABELS[type] ?? type;

type Tab = 'search' | 'romanzo' | 'capitolo' | 'personaggio' | 'arco' | 'timeline' | 'mondo' | 'coerenza' | 'editoriale' | 'openPoints' | 'documents' | 'admin';

const RESOLVED_KINDS = new Set(['resolves', 'pays_off']);
// Home tab for a related node when navigating from a panel pill.
const ENTITY_TAB: Partial<Record<string, Tab>> = {
  character: 'personaggio',
  plot_thread: 'arco',
  world_rule: 'mondo',
  power: 'mondo',
  faction: 'mondo',
  entity_class: 'mondo',
};

const isFrame = (plane: string | null): boolean => plane === 'frame';
const metaString = (node: KgNode, key: string): string | null => {
  const value = node.metadata[key];
  return value == null ? null : String(value);
};

interface GNode {
  id: string;
  label: string;
  type: string;
}

interface GLink {
  source: string;
  target: string;
  kind: string;
}

function graphFrom(nodes: KgNode[], edges: KgEdge[]): { nodes: GNode[]; links: GLink[] } {
  return {
    nodes: nodes.map((node) => ({ id: node.id, label: node.label, type: node.type })),
    links: edges.map((edge) => ({ source: edge.fromId, target: edge.toId, kind: edge.kind })),
  };
}

function openPointTitle(point: OpenPoint): string {
  return point.finding.label.replace(/^plot_thread_inactive:/, '');
}

function ChapterNavList({ chapters, selectedId, onOpen }: { chapters: ChapterSummary[]; selectedId: string | null; onOpen: (id: string) => void }) {
  return (
    <div className="result-list">
      {chapters.map((chapter) => (
        <button
          key={chapter.id}
          className={selectedId === chapter.id ? 'result active' : 'result'}
          onClick={() => onOpen(chapter.id)}
        >
          <span className="chapter-num">{chapter.number ?? '·'}</span>
          <span className="result-main">
            <b>{chapter.title}</b>
            <small>{isFrame(chapter.timePlane) ? 'cornice / interludio' : 'storia principale'}{chapter.date ? ` · ${chapter.date}` : ''}</small>
          </span>
        </button>
      ))}
      {!chapters.length && <div className="empty-state">Nessun capitolo</div>}
    </div>
  );
}

function RomanzoPanel({ chapters, selectedId, onOpen }: { chapters: ChapterSummary[]; selectedId: string | null; onOpen: (id: string) => void }) {
  const frame = chapters.filter((chapter) => isFrame(chapter.timePlane)).length;
  const main = chapters.length - frame;
  return (
    <div className="novel-panel">
      <div className="novel-head">
        <h2>Vista Romanzo</h2>
        <p className="novel-sub">
          Struttura a cornice · <b>{chapters.length}</b> capitoli ({main} storia · {frame} cornice/interludi).
          Ogni riga apre la Vista Capitolo.
        </p>
      </div>
      <div className="chapter-strip">
        {chapters.map((chapter) => (
          <button
            key={chapter.id}
            className={`chapter-row${isFrame(chapter.timePlane) ? ' frame' : ''}${selectedId === chapter.id ? ' active' : ''}`}
            onClick={() => onOpen(chapter.id)}
          >
            <span className="chapter-num">{chapter.number ?? '·'}</span>
            <span className="chapter-ti">
              {chapter.title}
              {chapter.chapterKind === 'interlude' && <small>interludio / cornice</small>}
            </span>
            <span className={`chapter-plane ${isFrame(chapter.timePlane) ? 'frame' : 'main'}`}>{isFrame(chapter.timePlane) ? 'cornice' : 'storia'}</span>
            <span className="chapter-date">{chapter.date ?? '—'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function CapitoloPanel({ packet, onOpen }: { packet: ChapterPacket | null; onOpen: (id: string, type: string) => void }) {
  if (!packet?.chapter) return <div className="graph-empty">Seleziona un capitolo</div>;
  const chapter = packet.chapter;
  const number = metaString(chapter, 'chapterNumber');
  const title = metaString(chapter, 'chapterTitle') ?? chapter.label;
  const plane = metaString(chapter, 'timePlane');
  const grouped = new Map<string, ChapterPacket['touches']>();
  for (const relation of packet.touches) {
    const list = grouped.get(relation.kind) ?? [];
    list.push(relation);
    grouped.set(relation.kind, list);
  }
  const graph = packetToGraph(chapter, packet.touches, packet.incomingMentions, [
    ...packet.prev.map((p) => ({ node: p, dir: 's' as const })),
    ...packet.next.map((n) => ({ node: n, dir: 'd' as const })),
  ]);
  return (
    <div className="novel-panel capitolo">
      <div className="novel-head">
        <span className="node-type"><span className="dot" style={{ background: colorFor('chapter') }} />capitolo · {isFrame(plane) ? 'cornice' : 'storia principale'}</span>
        <h2>{number ? `${number} · ` : ''}{title}</h2>
      </div>
      <div className="pill-row">
        {metaString(chapter, 'date') && <span className="pill">📅 <b>{metaString(chapter, 'date')}</b></span>}
        {plane && <span className="pill">piano <b>{plane}</b></span>}
        {metaString(chapter, 'documentChapterLabel') && <span className="pill">doc <b>{metaString(chapter, 'documentChapterLabel')}</b></span>}
        {metaString(chapter, 'primarySectionKey') && <span className="pill">sez. <b>{metaString(chapter, 'primarySectionKey')}</b></span>}
      </div>
      {chapter.content && <p className="node-content">{chapter.content}</p>}

      <section className="novel-block">
        <h3>Adiacenze <small>precedes</small></h3>
        <div className="adj-row">
          {packet.prev.map((p) => (
            <button key={p.id} className="adj" onClick={() => onOpen(p.id, 'chapter')}>← <b>{p.number ?? '·'}</b> {p.title}</button>
          ))}
          {packet.next.map((n) => (
            <button key={n.id} className="adj next" onClick={() => onOpen(n.id, 'chapter')}><b>{n.number ?? '·'}</b> {n.title} →</button>
          ))}
          {!packet.prev.length && !packet.next.length && <span className="muted">nessuna adiacenza</span>}
        </div>
      </section>

      <section className="novel-block">
        <h3>Chi c'è &amp; cosa tocca</h3>
        {grouped.size === 0 && <span className="muted">nessun collegamento</span>}
        {[...grouped.entries()].map(([kind, list]) => (
          <div className="touch-group" key={kind}>
            <span className="edge-kind">{kind}</span>
            <div className="touch-chips">
              {list.map((relation) => (
                <button key={`${kind}-${relation.node.id}`} className="pill touch" onClick={() => onOpen(relation.node.id, relation.node.type)}>
                  <span className="dot" style={{ background: colorFor(relation.node.type) }} />
                  {relation.node.label}
                  <small>{labelFor(relation.node.type)}</small>
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="novel-block">
        <h3>Riferimenti in entrata <small>{packet.incomingMentions.length} archi mentions</small></h3>
        {packet.incomingMentions.length === 0 && <span className="muted">nessun riferimento entrante</span>}
        <div className="mention-list">
          {packet.incomingMentions.map((mention, index) => (
            <div className="mention" key={`${mention.fromId}-${index}`}>
              <span className="mono">{mention.fromSection ?? mention.fromLabel}</span>
              <span className="arrow">→ mentions →</span>
              <span className="mono">{number ? `Cap ${number}` : title}</span>
              {mention.originalCitation && <small className="cite">{mention.originalCitation}</small>}
            </div>
          ))}
        </div>
        <p className="novel-note">Il numero non è più nel testo sorgente: il riferimento vive come arco id-based → integrità garantita anche dopo rinumerazione/split.</p>
      </section>
      <GraphView data={graph} onOpen={onOpen} />
    </div>
  );
}

function EntityNavList({ nodes, selectedId, onOpen }: { nodes: KgNode[]; selectedId: string | null; onOpen: (id: string) => void }) {
  const sorted = useMemo(() => [...nodes].sort((a, b) => a.label.localeCompare(b.label)), [nodes]);
  return (
    <div className="result-list">
      {sorted.map((node) => (
        <button key={node.id} className={selectedId === node.id ? 'result active' : 'result'} onClick={() => onOpen(node.id)}>
          <span className="dot" style={{ background: colorFor(node.type) }} />
          <span className="result-main"><b>{node.label}</b><small>{labelFor(node.type)}</small></span>
        </button>
      ))}
      {!sorted.length && <div className="empty-state">Nessun elemento</div>}
    </div>
  );
}

function groupTouches(touches: EntityPacket['touches']): Map<string, EntityPacket['touches']> {
  const grouped = new Map<string, EntityPacket['touches']>();
  for (const relation of touches) {
    const list = grouped.get(relation.kind) ?? [];
    list.push(relation);
    grouped.set(relation.kind, list);
  }
  return grouped;
}

function EntityPanel({ packet, onOpen }: { packet: EntityPacket | null; onOpen: (id: string, type: string) => void }) {
  if (!packet?.node) return <div className="graph-empty">Seleziona un elemento</div>;
  const node = packet.node;
  const grouped = groupTouches(packet.touches);
  const isArc = node.type === 'plot_thread';
  const resolved = packet.touches.some((relation) => RESOLVED_KINDS.has(relation.kind));
  const graph = packetToGraph(node, packet.touches, packet.incomingMentions);
  return (
    <div className="novel-panel capitolo">
      <div className="novel-head">
        <span className="node-type"><span className="dot" style={{ background: colorFor(node.type) }} />{labelFor(node.type)}</span>
        <h2>
          {node.label}
          {isArc && <span className={`arc-status ${resolved ? 'resolved' : 'open'}`}>{resolved ? 'risolto' : 'aperto'}</span>}
        </h2>
      </div>
      {node.content && <p className="node-content">{node.content}</p>}

      <section className="novel-block">
        <h3>Relazioni &amp; collegamenti <small>{packet.touches.length}</small></h3>
        {grouped.size === 0 && <span className="muted">nessun collegamento</span>}
        {[...grouped.entries()].map(([kind, list]) => (
          <div className="touch-group" key={kind}>
            <span className="edge-kind">{kind}</span>
            <div className="touch-chips">
              {list.map((relation) => (
                <button
                  key={`${kind}-${relation.node.id}`}
                  className="pill touch"
                  title={relation.direction === 'out' ? `${node.label} ${kind} →` : `→ ${kind} ${node.label}`}
                  onClick={() => onOpen(relation.node.id, relation.node.type)}
                >
                  <span className="dir">{relation.direction === 'out' ? '→' : '←'}</span>
                  <span className="dot" style={{ background: colorFor(relation.node.type) }} />
                  {relation.node.label}
                  <small>{labelFor(relation.node.type)}</small>
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>

      {packet.incomingMentions.length > 0 && (
        <section className="novel-block">
          <h3>Riferimenti in entrata <small>{packet.incomingMentions.length} archi mentions</small></h3>
          <div className="mention-list">
            {packet.incomingMentions.map((mention, index) => (
              <div className="mention" key={`${mention.fromId}-${index}`}>
                <span className="mono">{mention.fromSection ?? mention.fromLabel}</span>
                <span className="arrow">→ mentions →</span>
                <span className="mono">{node.label}</span>
                {mention.originalCitation && <small className="cite">{mention.originalCitation}</small>}
              </div>
            ))}
          </div>
        </section>
      )}
      <GraphView data={graph} onOpen={onOpen} />
    </div>
  );
}

function TimelinePanel({ entries, onOpenChapter, onOpenEntity }: { entries: TimelineEntry[]; onOpenChapter: (id: string) => void; onOpenEntity: (id: string) => void }) {
  const groups = useMemo(() => {
    const main = entries.filter((entry) => entry.timePlane === 'main_story');
    const frame = entries.filter((entry) => entry.timePlane === 'frame');
    const unanchored = entries.filter((entry) => entry.timePlane !== 'main_story' && entry.timePlane !== 'frame');
    return { main, frame, unanchored };
  }, [entries]);
  const renderRow = (entry: TimelineEntry) => (
    <div className="tl-event" key={entry.id}>
      <span className="tl-date">{entry.date ?? '—'}</span>
      <button className="tl-title" onClick={() => onOpenEntity(entry.id)}>{entry.label}</button>
      {entry.chapterId ? (
        <button className="tl-chapter" onClick={() => onOpenChapter(entry.chapterId!)}>
          Cap {entry.chapterNumber ?? '·'}{entry.chapterTitle ? ` · ${entry.chapterTitle}` : ''}
        </button>
      ) : (
        <span className="tl-chapter none">non ancorato</span>
      )}
    </div>
  );
  return (
    <div className="novel-panel">
      <div className="novel-head">
        <h2>Vista Timeline — bi-piano</h2>
        <p className="novel-sub">
          <b>{entries.length}</b> eventi. Data e ordine derivati dal capitolo collegato (archi <span className="edge-kind">part_of</span>/<span className="edge-kind">occurs_in</span>).
          Gli eventi non ancorati a un capitolo compaiono in fondo.
        </p>
      </div>
      {groups.main.length > 0 && (
        <section className="novel-block">
          <h3><span className="chapter-plane main">storia principale</span> <small>{groups.main.length}</small></h3>
          <div className="tl-list">{groups.main.map(renderRow)}</div>
        </section>
      )}
      {groups.frame.length > 0 && (
        <section className="novel-block">
          <h3><span className="chapter-plane frame">cornice</span> <small>{groups.frame.length}</small></h3>
          <div className="tl-list">{groups.frame.map(renderRow)}</div>
        </section>
      )}
      {groups.unanchored.length > 0 && (
        <section className="novel-block">
          <h3>Non ancorati <small>{groups.unanchored.length}</small></h3>
          <div className="tl-list">{groups.unanchored.map(renderRow)}</div>
        </section>
      )}
      {!entries.length && <div className="empty-state">Nessun evento timeline</div>}
    </div>
  );
}

function CoerenzaPanel({ health, onOpenPoints }: { health: HealthReport | null; onOpenPoints: () => void }) {
  if (!health) return <div className="graph-empty">Carico la salute del modello…</div>;
  const tiles: { n: number; l: string; s?: string; warn?: boolean }[] = [
    { n: health.totals.nodes, l: 'Nodi' },
    { n: health.totals.edges, l: 'Archi' },
    { n: health.openPoints, l: 'Punti aperti', s: 'plot_thread inattivi', warn: health.openPoints > 0 },
    { n: health.relatedToEdges, l: 'Archi generici', s: 'related_to da tipizzare', warn: health.relatedToEdges > 0 },
    { n: health.orphanNodes, l: 'Nodi orfani', s: 'senza archi', warn: health.orphanNodes > 0 },
    { n: health.chaptersMissingDate, l: 'Capitoli senza data', s: 'main_story', warn: health.chaptersMissingDate > 0 },
    { n: health.timelineUnanchored, l: 'Eventi non ancorati', s: 'senza capitolo', warn: health.timelineUnanchored > 0 },
  ];
  return (
    <div className="novel-panel">
      <div className="novel-head">
        <h2>Coerenza / Salute del modello</h2>
        <p className="novel-sub">Segnali strutturali <b>live</b> dal grafo. L'audit editoriale dettagliato (26 incongruenze su 5 assi) vive nei report versionati in <span className="edge-kind">dev-data/reports/</span> — il grafo contiene solo il modello consolidato.</p>
      </div>
      <div className="health-grid">
        {tiles.map((tile) => (
          <div className={`health-tile${tile.warn ? ' warn' : ''}`} key={tile.l}>
            <div className="health-n">{tile.n}</div>
            <div className="health-l">{tile.l}</div>
            {tile.s && <div className="health-s">{tile.s}</div>}
          </div>
        ))}
      </div>
      {health.openPoints > 0 && (
        <p className="novel-note">
          Ci sono <b>{health.openPoints}</b> punti aperti (fili narrativi inattivi). <button className="linklike" onClick={onOpenPoints}>Apri i Punti aperti →</button>
        </p>
      )}
    </div>
  );
}

const AXES: { key: string; label: string; desc: string; semantic?: boolean }[] = [
  { key: 'canone', label: 'Coerenza col canone', desc: 'La bozza non contraddice Bibbia/personaggi/regole/timeline (ancora = modello consolidato).' },
  { key: 'ridondanza', label: 'Ridondanza', desc: 'Ripetizioni vs capitoli già scritti — richiede embeddings semantici attivi.', semantic: true },
  { key: 'antipattern', label: 'Antipattern narrativi', desc: 'Info-dump, deus ex machina, telling>showing, ritmo piatto.' },
  { key: 'stile', label: 'Aderenza di stile', desc: 'Voce, registro, POV coerenti con le style_rule del progetto.' },
  { key: 'cronologia', label: 'Cronologia', desc: 'Date/ordine coerenti con la timeline e i capitoli adiacenti.' },
];

function EditorialePanel({ drafts, onOpen }: { drafts: KgNode[]; onOpen: (id: string, type: string) => void }) {
  return (
    <div className="novel-panel">
      <div className="novel-head">
        <h2>Cockpit Editoriale</h2>
        <p className="novel-sub">
          Plancia dello stato editoriale. La valutazione qualitativa della prosa avviene <b>in chat</b> con il modello sul context packet (canone come ground truth); la pipeline MCP <span className="edge-kind">novel_*</span> persiste bozze e decisioni. Il FE resta di sola lettura.
        </p>
      </div>
      <section className="novel-block">
        <h3>Bozze &amp; sessioni <small>{drafts.length}</small></h3>
        {drafts.length === 0 ? (
          <p className="muted">Nessuna bozza ancora nel grafo. Incolla in chat una proposta di capitolo: la valuto sui 5 assi qui sotto e consolido i dettagli emersi nel modello.</p>
        ) : (
          <div className="result-list">
            {drafts.map((draft) => (
              <button key={draft.id} className="result" onClick={() => onOpen(draft.id, draft.type)}>
                <span className="dot" style={{ background: colorFor(draft.type) }} />
                <span className="result-main"><b>{draft.label}</b><small>{labelFor(draft.type)}</small></span>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="novel-block">
        <h3>Framework di valutazione — 5 assi</h3>
        <div className="axes-grid">
          {AXES.map((axis) => (
            <div className="axis-card" key={axis.key}>
              <div className="axis-h">{axis.label}{axis.semantic && <span className="tag-warn">semantico</span>}</div>
              <p className="axis-d">{axis.desc}</p>
            </div>
          ))}
        </div>
        <p className="novel-note">La ridondanza semantica cross-capitolo si attiva dopo il redeploy NAS + <span className="edge-kind">kg_backfill_embeddings</span> (config Ollama già in main). Gli altri assi sono ancorati alla Bibbia consolidata.</p>
      </section>
    </div>
  );
}

// ---- per-view interactive force-directed graph (canvas) ----
interface GData { nodes: { id: string; type: string; label: string; frame?: boolean }[]; edges: { s: string; d: string; k: string }[]; }
const SANS_F = 'system-ui, sans-serif';
const MONO_F = 'ui-monospace, monospace';
const EK_COLOR: Record<string, string> = {
  mentions: '#e6b450', precedes: '#74c6a4', defines: '#7fa6d9', part_of: '#556184', about: '#9b8ce6',
  applies_to: '#7fa6d9', occurs_in: '#9b8ce6', occurs_at: '#9b8ce6', threatens: '#de8080', loves: '#e39b8a',
  protects: '#74c6a4', family_of: '#b79be6', appears_in: '#c6b074', supersedes: '#de8080', constrains: '#de8080',
  resolves: '#74c6a4', pays_off: '#74c6a4', sets_up: '#7fa6d9', foreshadows: '#9b8ce6', causes: '#de8080', has_arc: '#c6b074',
};
const ekColor = (kind: string): string => EK_COLOR[kind] ?? '#586079';
const nodeRadius = (type: string): number => (type === 'chapter' || type === 'character' ? 9 : 7);

function packetToGraph(center: KgNode, touches: EntityPacket['touches'], mentions: EntityPacket['incomingMentions'], adjacency: { node: ChapterSummary; dir: 's' | 'd' }[] = []): GData {
  const nodes: GData['nodes'] = [{ id: center.id, type: center.type, label: center.label }];
  const edges: GData['edges'] = [];
  const seen = new Set([center.id]);
  const add = (id: string, type: string, label: string, frame?: boolean): void => {
    if (!seen.has(id)) { seen.add(id); nodes.push({ id, type, label, frame }); }
  };
  for (const relation of touches) {
    add(relation.node.id, relation.node.type, relation.node.label);
    edges.push(relation.direction === 'out' ? { s: center.id, d: relation.node.id, k: relation.kind } : { s: relation.node.id, d: center.id, k: relation.kind });
  }
  for (const adj of adjacency) {
    add(adj.node.id, 'chapter', `${adj.node.number ?? ''} ${adj.node.title}`.trim(), isFrame(adj.node.timePlane));
    edges.push(adj.dir === 's' ? { s: adj.node.id, d: center.id, k: 'precedes' } : { s: center.id, d: adj.node.id, k: 'precedes' });
  }
  for (const mention of mentions.slice(0, 12)) {
    add(mention.fromId, mention.fromType, mention.fromSection ?? mention.fromLabel);
    edges.push({ s: mention.fromId, d: center.id, k: 'mentions' });
  }
  return { nodes, edges };
}

function GraphView({ data, onOpen }: { data: GData; onOpen?: (id: string, type: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !data.nodes.length) return;
    const types: string[] = [];
    const kinds: string[] = [];
    for (const n of data.nodes) if (!types.includes(n.type)) types.push(n.type);
    for (const e of data.edges) if (!kinds.includes(e.k)) kinds.push(e.k);
    const offT: Record<string, boolean> = {};
    const offK: Record<string, boolean> = {};

    host.innerHTML = '';
    const fil = document.createElement('div');
    fil.className = 'gfil';
    const typeMeta = new Map(types.map((t) => [t, { color: colorFor(t), name: labelFor(t) }]));
    const mkRow = (label: string, items: string[], color: (v: string) => string, name: (v: string) => string, store: Record<string, boolean>): HTMLDivElement => {
      const row = document.createElement('div');
      row.className = 'gfrow';
      const lb = document.createElement('span');
      lb.className = 'lb';
      lb.textContent = label;
      row.appendChild(lb);
      for (const it of items) {
        const c = document.createElement('button');
        c.className = 'gchip';
        c.type = 'button';
        c.innerHTML = `<span class="cd" style="background:${color(it)}"></span>${name(it)}`;
        c.addEventListener('click', () => { store[it] = !store[it]; c.classList.toggle('off', !!store[it]); reheat(0.5); });
        row.appendChild(c);
      }
      return row;
    };
    fil.appendChild(mkRow('Tipo nodo', types, (t) => typeMeta.get(t)!.color, (t) => typeMeta.get(t)!.name, offT));
    fil.appendChild(mkRow('Tipo arco', kinds, ekColor, (k) => k, offK));
    host.appendChild(fil);
    const wrap = document.createElement('div');
    wrap.className = 'gwrap';
    const cv = document.createElement('canvas');
    cv.className = 'gcanvas';
    wrap.appendChild(cv);
    const tip = document.createElement('div');
    tip.className = 'gtip';
    wrap.appendChild(tip);
    host.appendChild(wrap);
    const hint = document.createElement('div');
    hint.className = 'ghint';
    hint.textContent = 'Trascina i nodi · hover per evidenziare vicini ed etichette-arco · click per aprire · chip per filtrare';
    host.appendChild(hint);

    const ctx = cv.getContext('2d')!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let W = 0;
    const H = 360;
    interface N { id: string; type: string; label: string; frame?: boolean; x: number; y: number; vx: number; vy: number; fx: number; fy: number; }
    const N: N[] = data.nodes.map((n) => ({ ...n, x: 0, y: 0, vx: 0, vy: 0, fx: 0, fy: 0 }));
    const byId = new Map(N.map((n) => [n.id, n]));
    const E = data.edges.map((e) => ({ s: byId.get(e.s), d: byId.get(e.d), k: e.k })).filter((e): e is { s: N; d: N; k: string } => !!e.s && !!e.d);
    let alpha = 0;
    let hover: N | null = null;
    let drag: N | null = null;
    let raf: number | null = null;
    let seeded = false;

    const fit = (): void => { W = cv.clientWidth || host.clientWidth || 600; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    const seed = (): void => { fit(); const cx = W / 2; const cy = H / 2; const R = Math.min(W, H) / 2 - 42; N.forEach((n, i) => { const a = (i / N.length) * Math.PI * 2; n.x = cx + Math.cos(a) * R * 0.7; n.y = cy + Math.sin(a) * R * 0.7; }); seeded = true; };
    const vis = (n: N): boolean => !offT[n.type];
    const visE = (e: { s: N; d: N; k: string }): boolean => !offK[e.k] && vis(e.s) && vis(e.d);
    const neighbor = (a: N, b: N): boolean => E.some((e) => visE(e) && ((e.s === a && e.d === b) || (e.d === a && e.s === b)));
    const tick = (): void => {
      const vs = N.filter(vis);
      for (let i = 0; i < vs.length; i++) {
        const a = vs[i];
        let fx = 0;
        let fy = 0;
        for (let j = 0; j < vs.length; j++) {
          if (i === j) continue;
          const b = vs[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy || 0.01;
          const d = Math.sqrt(d2);
          const f = 2700 / d2;
          fx += (dx / d) * f;
          fy += (dy / d) * f;
        }
        fx += (W / 2 - a.x) * 0.008;
        fy += (H / 2 - a.y) * 0.008;
        a.fx = fx;
        a.fy = fy;
      }
      E.forEach((e) => { if (!visE(e)) return; const dx = e.d.x - e.s.x; const dy = e.d.y - e.s.y; const d = Math.sqrt(dx * dx + dy * dy) || 0.01; const f = (d - 98) * 0.015; const ux = dx / d; const uy = dy / d; e.s.fx += ux * f; e.s.fy += uy * f; e.d.fx -= ux * f; e.d.fy -= uy * f; });
      vs.forEach((n) => { if (n === drag) return; n.vx = (n.vx + n.fx * alpha) * 0.86; n.vy = (n.vy + n.fy * alpha) * 0.86; n.x = Math.max(26, Math.min(W - 26, n.x + n.vx)); n.y = Math.max(24, Math.min(H - 24, n.y + n.vy)); });
      alpha *= 0.975;
    };
    const draw = (): void => {
      ctx.clearRect(0, 0, W, H);
      E.forEach((e) => { if (!visE(e)) return; const hl = !!hover && (e.s === hover || e.d === hover); ctx.strokeStyle = ekColor(e.k); ctx.globalAlpha = hover ? (hl ? 0.95 : 0.1) : 0.5; ctx.lineWidth = hl ? 2 : 1; ctx.beginPath(); ctx.moveTo(e.s.x, e.s.y); ctx.lineTo(e.d.x, e.d.y); ctx.stroke(); });
      ctx.globalAlpha = 1;
      if (hover) { ctx.textAlign = 'center'; ctx.font = `10px ${MONO_F}`; E.forEach((e) => { if (!visE(e) || (e.s !== hover && e.d !== hover)) return; ctx.fillStyle = ekColor(e.k); ctx.fillText(e.k, (e.s.x + e.d.x) / 2, (e.s.y + e.d.y) / 2 - 3); }); }
      N.forEach((n) => {
        if (!vis(n)) return;
        const r = nodeRadius(n.type);
        const dim = !!hover && hover !== n && !neighbor(hover, n);
        ctx.globalAlpha = dim ? 0.26 : 1;
        if (n.frame) { ctx.beginPath(); ctx.arc(n.x, n.y, r + 3, 0, 7); ctx.strokeStyle = '#9b8ce6'; ctx.lineWidth = 1.5; ctx.stroke(); }
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 7); ctx.fillStyle = colorFor(n.type); ctx.fill();
        if (n === hover || n === drag) { ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke(); }
        ctx.font = `11px ${SANS_F}`; ctx.fillStyle = '#eaecf2'; ctx.textAlign = 'center';
        const lbl = n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label;
        ctx.fillText(lbl, n.x, n.y + r + 11);
      });
      ctx.globalAlpha = 1;
    };
    const loop = (): void => { tick(); draw(); if (alpha > 0.02) raf = requestAnimationFrame(loop); else { raf = null; draw(); } };
    function reheat(a: number): void { if (!seeded) seed(); else fit(); alpha = Math.max(alpha, a); if (!raf) raf = requestAnimationFrame(loop); }
    const pos = (ev: MouseEvent): { x: number; y: number } => { const r = cv.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
    const pick = (p: { x: number; y: number }): N | null => { let best: N | null = null; let bd = 1e9; N.forEach((n) => { if (!vis(n)) return; const dx = n.x - p.x; const dy = n.y - p.y; const d = dx * dx + dy * dy; const rr = nodeRadius(n.type) + 6; if (d < rr * rr && d < bd) { bd = d; best = n; } }); return best; };
    let moved = false;
    const onMove = (ev: MouseEvent): void => {
      const p = pos(ev);
      if (drag) { drag.x = p.x; drag.y = p.y; drag.vx = 0; drag.vy = 0; moved = true; reheat(0.4); }
      const h = pick(p);
      if (h !== hover) { hover = h; if (!raf) draw(); }
      if (h) { tip.style.opacity = '1'; tip.style.left = `${p.x + 12}px`; tip.style.top = `${p.y + 8}px`; tip.innerHTML = `<b>${h.label}</b><small>${labelFor(h.type)}${h.frame ? ' · cornice' : ''}</small>`; } else tip.style.opacity = '0';
    };
    const onDown = (ev: MouseEvent): void => { drag = pick(pos(ev)); moved = false; if (drag) reheat(0.4); };
    const onUp = (ev: MouseEvent): void => { if (drag && !moved && onOpenRef.current) onOpenRef.current(drag.id, drag.type); drag = null; void ev; };
    const onLeave = (): void => { hover = null; tip.style.opacity = '0'; if (!raf) draw(); };
    cv.addEventListener('mousemove', onMove);
    cv.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    cv.addEventListener('mouseleave', onLeave);
    reheat(0.7);
    return () => { if (raf) cancelAnimationFrame(raf); cv.removeEventListener('mousemove', onMove); cv.removeEventListener('mousedown', onDown); window.removeEventListener('mouseup', onUp); cv.removeEventListener('mouseleave', onLeave); host.innerHTML = ''; };
  }, [data]);
  if (!data.nodes.length) return null;
  return (
    <div className="gmount">
      <h3>Grafo del modello <small>{data.nodes.length} nodi · {data.edges.length} archi</small></h3>
      <div ref={hostRef} />
    </div>
  );
}

function StatBar({ stats }: { stats: KgStats | null }) {
  const topTypes = useMemo(() => Object.entries(stats?.nodeTypes ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8), [stats]);
  return (
    <div className="statbar" aria-label="Statistiche grafo">
      <span className="stat"><Database size={15} />{stats?.nodes ?? 0}</span>
      <span className="stat"><Network size={15} />{stats?.edges ?? 0}</span>
      {topTypes.map(([type, count]) => (
        <span className="type-stat" key={type}>
          <span className="dot" style={{ background: colorFor(type) }} />
          {labelFor(type)}<b>{count}</b>
        </span>
      ))}
    </div>
  );
}

export function App() {
  const [stats, setStats] = useState<KgStats | null>(null);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [results, setResults] = useState<KgNode[]>([]);
  const [documents, setDocuments] = useState<KgNode[]>([]);
  const [openPoints, setOpenPoints] = useState<OpenPoint[]>([]);
  const [selectedOpenPointId, setSelectedOpenPointId] = useState<string | null>(null);
  const [graph, setGraph] = useState<{ nodes: GNode[]; links: GLink[] }>({ nodes: [], links: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KgNode | null>(null);
  const [tab, setTab] = useState<Tab>('search');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminMessage, setAdminMessage] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>('upsert');
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [snapshotFileName, setSnapshotFileName] = useState('');
  const [importResult, setImportResult] = useState<SnapshotImportResult | null>(null);
  const [chapters, setChapters] = useState<ChapterSummary[]>([]);
  const [chapterPacket, setChapterPacket] = useState<ChapterPacket | null>(null);
  const [characters, setCharacters] = useState<KgNode[]>([]);
  const [arcs, setArcs] = useState<KgNode[]>([]);
  const [world, setWorld] = useState<KgNode[]>([]);
  const [entityPacket, setEntityPacket] = useState<EntityPacket | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [drafts, setDrafts] = useState<KgNode[]>([]);
  const graphRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ width: 900, height: 640 });

  const selectedOpenPoint = useMemo(
    () => openPoints.find((point) => point.finding.id === selectedOpenPointId) ?? null,
    [openPoints, selectedOpenPointId],
  );

  const refreshStats = useCallback(async () => {
    setStats(await getKgStats());
  }, []);

  const loadNodes = useCallback(async (type?: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await listKgNodes(80, type?.trim() || undefined);
      setResults(response.nodes);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadChapters = useCallback(async () => {
    if (chapters.length) return;
    setLoading(true);
    setError(null);
    try {
      setChapters((await listChapters()).chapters);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [chapters.length]);

  const openChapter = useCallback(async (id: string) => {
    setTab('capitolo');
    setSelectedId(id);
    setLoading(true);
    setError(null);
    try {
      setChapterPacket(await getChapterPacket(id));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCharacters = useCallback(async () => {
    if (characters.length) return;
    setLoading(true);
    setError(null);
    try {
      setCharacters((await listKgNodes(200, 'character')).nodes);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [characters.length]);

  const loadArcs = useCallback(async () => {
    if (arcs.length) return;
    setLoading(true);
    setError(null);
    try {
      setArcs((await listKgNodes(200, 'plot_thread')).nodes);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [arcs.length]);

  const loadTimeline = useCallback(async () => {
    if (timeline.length) return;
    setLoading(true);
    setError(null);
    try {
      setTimeline((await getTimeline()).entries);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [timeline.length]);

  const loadWorld = useCallback(async () => {
    if (world.length) return;
    setLoading(true);
    setError(null);
    try {
      const [rules, powers] = await Promise.all([listKgNodes(200, 'world_rule'), listKgNodes(200, 'power')]);
      setWorld([...rules.nodes, ...powers.nodes]);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [world.length]);

  const loadHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHealth(await getHealth());
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDrafts = useCallback(async () => {
    if (drafts.length) return;
    setLoading(true);
    setError(null);
    try {
      const [chapterDrafts, sessions] = await Promise.all([listKgNodes(100, 'chapter_draft'), listKgNodes(100, 'editing_session')]);
      setDrafts([...chapterDrafts.nodes, ...sessions.nodes]);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [drafts.length]);

  const openEntity = useCallback(async (id: string, type: string) => {
    // Chapters keep their dedicated packet view; everything else uses the entity packet.
    if (type === 'chapter') {
      void openChapter(id);
      return;
    }
    setSelectedId(id);
    setTab((current) => ENTITY_TAB[type] ?? (current === 'personaggio' || current === 'arco' || current === 'mondo' ? current : 'personaggio'));
    setLoading(true);
    setError(null);
    try {
      setEntityPacket(await getEntityPacket(id));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [openChapter]);

  useEffect(() => {
    void refreshStats().catch((err) => setError(String(err)));
  }, [refreshStats]);

  useEffect(() => {
    void loadNodes().catch((err) => setError(String(err)));
  }, [loadNodes]);

  useEffect(() => {
    const element = graphRef.current;
    if (!element) return;
    const update = (): void => setDims({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      void loadNodes(typeFilter);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await searchKg(q, typeFilter.trim() || undefined, 40);
      setResults(response.nodes);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [loadNodes, query, typeFilter]);

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listKgDocuments(80);
      setDocuments(response.documents);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOpenPoints = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listKgOpenPoints(160);
      setOpenPoints(response.points);
      setSelectedOpenPointId((current) => {
        if (current && response.points.some((point) => point.finding.id === current)) return current;
        return response.points[0]?.finding.id ?? null;
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const expandNode = useCallback(async (id: string) => {
    setSelectedId(id);
    setLoading(true);
    setError(null);
    try {
      const [neighbors, nodeResponse] = await Promise.all([getKgNeighbors(id, 2), getKgNode(id)]);
      setGraph(graphFrom(neighbors.nodes, neighbors.edges));
      setDetail(nodeResponse.node);
      void refreshStats();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [refreshStats]);

  const runExport = useCallback(async () => {
    setAdminBusy(true);
    setError(null);
    setAdminMessage(null);
    try {
      const exported = await exportGraphSnapshot();
      const url = URL.createObjectURL(exported.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exported.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setAdminMessage(`Export generato: ${exported.filename}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setAdminBusy(false);
    }
  }, []);

  const loadSnapshotFile = useCallback(async (file: File) => {
    setError(null);
    setAdminMessage(null);
    setImportResult(null);
    setSnapshot(null);
    setSnapshotFileName(file.name);
    try {
      const parsed = JSON.parse(await file.text()) as GraphSnapshot;
      setSnapshot(parsed);
      setAdminMessage(`Snapshot caricato: ${file.name}`);
    } catch (err) {
      setError(`Snapshot non valido: ${String(err)}`);
    }
  }, []);

  const runImportDryRun = useCallback(async () => {
    if (!snapshot) return;
    setAdminBusy(true);
    setError(null);
    setAdminMessage(null);
    try {
      const result = await dryRunGraphSnapshotImport(snapshot, importMode);
      setImportResult(result);
      setAdminMessage(result.ok ? 'Dry-run import approvato' : 'Dry-run import respinto');
    } catch (err) {
      setError(String(err));
    } finally {
      setAdminBusy(false);
    }
  }, [importMode, snapshot]);

  const runImportCommit = useCallback(async () => {
    if (!snapshot || !importResult?.ok) return;
    if (importMode === 'replaceProject' && !window.confirm('Confermi la sostituzione completa del progetto corrente?')) return;
    setAdminBusy(true);
    setError(null);
    setAdminMessage(null);
    try {
      const result = await commitGraphSnapshotImport(snapshot, importMode, importResult.report.targetProjectId);
      setImportResult(result);
      setAdminMessage(result.ok ? `Import completato: ${result.written?.nodes ?? 0} nodi, ${result.written?.edges ?? 0} archi` : 'Import respinto');
      if (result.ok) {
        setTab('search');
        void refreshStats();
        void loadNodes();
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setAdminBusy(false);
    }
  }, [importMode, importResult, loadNodes, refreshStats, snapshot]);

  const activeList = tab === 'documents' ? documents : results;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Rete Neurale Romanzo Gabriele</p>
          <h1>Grafo narrativo</h1>
        </div>
        <button className="icon-button" title="Aggiorna statistiche" onClick={() => void refreshStats()}>
          <RefreshCw size={18} />
        </button>
      </header>

      <StatBar stats={stats} />

      <main className="workspace">
        <aside className="sidebar">
          <div className="nav-group">Panoramica</div>
          <div className="tabs" role="tablist">
            <button className={tab === 'romanzo' ? 'active' : ''} onClick={() => { setTab('romanzo'); void loadChapters(); }}><BookOpen size={15} />Romanzo</button>
            <button className={tab === 'timeline' ? 'active' : ''} onClick={() => { setTab('timeline'); void loadTimeline(); }}><Clock size={15} />Timeline</button>
            <button className={tab === 'coerenza' ? 'active' : ''} onClick={() => { setTab('coerenza'); void loadHealth(); }}><Activity size={15} />Coerenza</button>
          </div>
          <div className="nav-group">Entità</div>
          <div className="tabs" role="tablist">
            <button className={tab === 'capitolo' ? 'active' : ''} onClick={() => { setTab('capitolo'); void loadChapters(); }}><ScrollText size={15} />Capitolo</button>
            <button className={tab === 'personaggio' ? 'active' : ''} onClick={() => { setTab('personaggio'); void loadCharacters(); }}><Users size={15} />Personaggi</button>
            <button className={tab === 'arco' ? 'active' : ''} onClick={() => { setTab('arco'); void loadArcs(); }}><GitBranch size={15} />Archi</button>
            <button className={tab === 'mondo' ? 'active' : ''} onClick={() => { setTab('mondo'); void loadWorld(); }}><Globe2 size={15} />Mondo</button>
          </div>
          <div className="nav-group">Lavoro</div>
          <div className="tabs" role="tablist">
            <button className={tab === 'editoriale' ? 'active' : ''} onClick={() => { setTab('editoriale'); void loadDrafts(); }}><PenLine size={15} />Editoriale</button>
            <button className={tab === 'search' ? 'active' : ''} onClick={() => setTab('search')}><Search size={15} />Grafo</button>
            <button className={tab === 'openPoints' ? 'active' : ''} onClick={() => { setTab('openPoints'); void loadOpenPoints(); }}><ListChecks size={15} />Punti aperti</button>
            <button className={tab === 'documents' ? 'active' : ''} onClick={() => { setTab('documents'); void loadDocuments(); }}><FileText size={15} />Documenti</button>
            <button className={tab === 'admin' ? 'active' : ''} onClick={() => setTab('admin')}><ShieldCheck size={15} />Admin</button>
          </div>

          {tab === 'search' && (
            <div className="search-box">
              <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(); }} placeholder="Cerca nel romanzo" />
              <input value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(); }} placeholder="tipo" />
              <button className="icon-button primary" title="Cerca" onClick={() => void runSearch()}><Search size={18} /></button>
            </div>
          )}

          {tab === 'admin' && (
            <div className="admin-box">
              <div className="admin-section">Esporta l'intero modello neurale</div>
              <button className="command-button" onClick={() => void runExport()} disabled={adminBusy}>
                <Download size={16} />Scarica modello (.json)
              </button>
              <div className="admin-section">Ricarica un modello da file</div>
              <label className="file-button">
                <Upload size={16} />Carica snapshot
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void loadSnapshotFile(file);
                  }}
                />
              </label>
              <select
                value={importMode}
                onChange={(event) => {
                  setImportMode(event.target.value as ImportMode);
                  setImportResult(null);
                }}
              >
                <option value="upsert">Aggiornamento (upsert: fonde/aggiorna)</option>
                <option value="replaceProject">Sostituzione globale (svuota e ricarica)</option>
              </select>
              {importMode === 'replaceProject' && (
                <div className="admin-line bad">⚠ Cancella l'intero modello attuale prima di ricaricare. Irreversibile.</div>
              )}
              <button className="command-button" onClick={() => void runImportDryRun()} disabled={adminBusy || !snapshot}>
                Verifica (dry-run)
              </button>
              <button className="command-button danger" onClick={() => void runImportCommit()} disabled={adminBusy || !snapshot || !importResult?.ok}>
                {importMode === 'replaceProject' ? 'Applica sostituzione' : 'Applica aggiornamento'}
              </button>
              {snapshotFileName && <div className="admin-line">{snapshotFileName}</div>}
              {adminMessage && <div className="admin-line ok">{adminMessage}</div>}
              {importResult && (
                <div className="import-report">
                  <b>{importResult.report.ok ? 'OK' : 'ERRORE'}</b>
                  <span>Nodi: {importResult.report.counts.nodes} / attuali {importResult.report.counts.currentNodes}</span>
                  <span>Archi: {importResult.report.counts.edges} / attuali {importResult.report.counts.currentEdges}</span>
                  {importResult.report.warnings.map((warning) => <span key={warning} className="warn">{warning}</span>)}
                  {importResult.report.errors.map((entry) => <span key={entry} className="bad">{entry}</span>)}
                </div>
              )}
            </div>
          )}

          {error && <div className="error-line">{error}</div>}
          {loading && <div className="loading-line">Caricamento</div>}

          {tab === 'openPoints' ? (
            <div className="open-point-list">
              {openPoints.map((point) => (
                <button
                  key={point.finding.id}
                  className={selectedOpenPointId === point.finding.id ? 'open-point active' : 'open-point'}
                  onClick={() => setSelectedOpenPointId(point.finding.id)}
                >
                  <span className="open-point-marker" />
                  <span className="open-point-main">
                    <b>{openPointTitle(point)}</b>
                    <small>{point.plotThread?.label ?? 'plot thread non collegato'}</small>
                    <span>{point.finding.content}</span>
                  </span>
                </button>
              ))}
              {!openPoints.length && !loading && <div className="empty-state">Nessun punto aperto</div>}
            </div>
          ) : tab === 'romanzo' || tab === 'capitolo' ? (
            <ChapterNavList chapters={chapters} selectedId={selectedId} onOpen={(id) => void openChapter(id)} />
          ) : tab === 'personaggio' ? (
            <EntityNavList nodes={characters} selectedId={selectedId} onOpen={(id) => void openEntity(id, 'character')} />
          ) : tab === 'arco' ? (
            <EntityNavList nodes={arcs} selectedId={selectedId} onOpen={(id) => void openEntity(id, 'plot_thread')} />
          ) : tab === 'mondo' ? (
            <EntityNavList nodes={world} selectedId={selectedId} onOpen={(id) => void openEntity(id, world.find((node) => node.id === id)?.type ?? 'world_rule')} />
          ) : tab === 'timeline' || tab === 'coerenza' || tab === 'editoriale' ? (
            <div className="empty-state">Contenuto nel pannello →</div>
          ) : (
            <div className={tab === 'admin' ? 'result-list hidden' : 'result-list'}>
              {activeList.map((node) => (
                <button key={node.id} className={selectedId === node.id ? 'result active' : 'result'} onClick={() => void expandNode(node.id)}>
                  <span className="dot" style={{ background: colorFor(node.type) }} />
                  <span className="result-main"><b>{node.label}</b><small>{labelFor(node.type)}</small></span>
                </button>
              ))}
              {!activeList.length && !loading && <div className="empty-state">Nessun elemento narrativo</div>}
            </div>
          )}
        </aside>

        <section className="graph-panel" ref={graphRef}>
          {tab === 'openPoints' ? (
            <div className="open-point-detail">
              {selectedOpenPoint ? (
                <>
                  <span className="node-type"><span className="open-point-marker" />punto aperto</span>
                  <h2>{openPointTitle(selectedOpenPoint)}</h2>
                  <p className="node-content">{selectedOpenPoint.finding.content}</p>
                  {selectedOpenPoint.plotThread && (
                    <section>
                      <h3>Filo narrativo</h3>
                      <p className="node-content compact">{selectedOpenPoint.plotThread.label}</p>
                      {selectedOpenPoint.plotThread.content && <p className="node-content compact">{selectedOpenPoint.plotThread.content}</p>}
                    </section>
                  )}
                  <section>
                    <h3>Metadata</h3>
                    <pre>{JSON.stringify(selectedOpenPoint.finding.metadata, null, 2)}</pre>
                  </section>
                  <section>
                    <h3>Provenienza</h3>
                    <pre>{JSON.stringify(selectedOpenPoint.finding.provenance, null, 2)}</pre>
                  </section>
                </>
              ) : (
                <div className="graph-empty">Nessun punto aperto</div>
              )}
            </div>
          ) : tab === 'romanzo' ? (
            <RomanzoPanel chapters={chapters} selectedId={selectedId} onOpen={(id) => void openChapter(id)} />
          ) : tab === 'capitolo' ? (
            <CapitoloPanel packet={chapterPacket} onOpen={(id, type) => void openEntity(id, type)} />
          ) : tab === 'personaggio' || tab === 'arco' || tab === 'mondo' ? (
            <EntityPanel packet={entityPacket} onOpen={(id, type) => void openEntity(id, type)} />
          ) : tab === 'timeline' ? (
            <TimelinePanel entries={timeline} onOpenChapter={(id) => void openChapter(id)} onOpenEntity={(id) => void openEntity(id, 'timeline_event')} />
          ) : tab === 'coerenza' ? (
            <CoerenzaPanel health={health} onOpenPoints={() => { setTab('openPoints'); void loadOpenPoints(); }} />
          ) : tab === 'editoriale' ? (
            <EditorialePanel drafts={drafts} onOpen={(id, type) => void openEntity(id, type)} />
          ) : graph.nodes.length > 0 ? (
            <ForceGraph2D<GNode, GLink>
              width={dims.width}
              height={dims.height}
              graphData={graph}
              nodeId="id"
              nodeLabel={(node) => `${node.label} - ${labelFor(node.type)}`}
              nodeColor={(node) => colorFor(node.type)}
              nodeRelSize={5}
              linkLabel={(link) => link.kind}
              linkColor={() => 'rgba(71, 85, 105, 0.36)'}
              linkDirectionalArrowLength={4}
              linkDirectionalArrowRelPos={1}
              onNodeClick={(node) => void expandNode(node.id)}
            />
          ) : (
            <div className="graph-empty">Seleziona un nodo narrativo</div>
          )}

          {tab === 'search' && detail && (
            <aside className="detail-panel">
              <button className="close-button" title="Chiudi" onClick={() => setDetail(null)}><X size={18} /></button>
              <span className="node-type"><span className="dot" style={{ background: colorFor(detail.type) }} />{labelFor(detail.type)}</span>
              <h2>{detail.label}</h2>
              {detail.content && <p className="node-content">{detail.content}</p>}
              {Object.keys(detail.metadata).length > 0 && (
                <section>
                  <h3>Metadata</h3>
                  <pre>{JSON.stringify(detail.metadata, null, 2)}</pre>
                </section>
              )}
              {Object.keys(detail.provenance).length > 0 && (
                <section>
                  <h3>Provenienza</h3>
                  <pre>{JSON.stringify(detail.provenance, null, 2)}</pre>
                </section>
              )}
            </aside>
          )}
        </section>
      </main>
    </div>
  );
}
