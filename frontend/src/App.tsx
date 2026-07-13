import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from 'react-force-graph-2d';
import { Activity, BookOpen, Check, ChevronDown, Clock, Copy, Database, Download, Feather, FileText, GitBranch, Globe2, ListChecks, Network, PenLine, RefreshCw, ScrollText, Search, ShieldCheck, Sparkles, Upload, Users, X } from 'lucide-react';
import {
  commitGraphSnapshotImport,
  dryRunGraphSnapshotImport,
  exportGraphSnapshot,
  getConfig,
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
import { ChapterDraftEditor } from './ChapterDraftEditor';

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
  power: '#0ea5e9',
  faction: '#c026d3',
  artifact: '#a16207',
  symbol: '#7c3aed',
  motif: '#9333ea',
  entity_class: '#0d9488',
  narrative_constraint: '#b45309',
  revelation: '#c026d3',
  secret: '#9f1239',
  conflict: '#dc2626',
  character_trait: '#15803d',
  character_goal: '#0f766e',
  character_belief: '#166534',
  character_wound: '#9f1239',
  emotional_state: '#65a30d',
  knowledge_state: '#0891b2',
  editing_session: '#f97316',
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
  power: 'potere',
  faction: 'fazione',
  artifact: 'oggetto/artefatto',
  symbol: 'simbolo',
  motif: 'motivo ricorrente',
  entity_class: 'classe di entità',
  narrative_constraint: 'vincolo narrativo',
  revelation: 'rivelazione',
  secret: 'segreto',
  conflict: 'conflitto',
  character_trait: 'tratto',
  character_goal: 'obiettivo',
  character_belief: 'convinzione',
  character_wound: 'ferita',
  emotional_state: 'stato emotivo',
  knowledge_state: 'stato conoscenza',
  editing_session: 'sessione editing',
};

const colorFor = (type: string): string => TYPE_COLORS[type] ?? '#334155';
const labelFor = (type: string): string => TYPE_LABELS[type] ?? type;

type Tab = 'search' | 'romanzo' | 'capitolo' | 'personaggio' | 'arco' | 'timeline' | 'mondo' | 'temi' | 'stile' | 'coerenza' | 'editoriale' | 'openPoints' | 'documents' | 'admin';

// Worldbuilding / thematic / style node types surfaced by the dedicated views.
const WORLD_TYPES = ['world_rule', 'power', 'location', 'faction', 'artifact', 'symbol', 'entity_class', 'glossary_term'];
const THEME_TYPES = ['theme', 'motif'];
const STYLE_TYPES = ['style_rule', 'narrative_constraint', 'character_voice'];
// Category order for the character roster (mirrors doc branch 2).
const CHARACTER_CATEGORY_ORDER = ['Protagonisti', 'Personaggi Principali', 'Forze Sovrannaturali', 'Personaggi Secondari Ricorrenti', 'Personaggi Secondari Funzionali', 'Cornice Narrativa', 'Altri'];

const RESOLVED_KINDS = new Set(['resolves', 'pays_off']);
// Home tab for a related node when navigating from a panel pill.
const ENTITY_TAB: Partial<Record<string, Tab>> = {
  character: 'personaggio',
  plot_thread: 'arco',
  world_rule: 'mondo',
  power: 'mondo',
  location: 'mondo',
  faction: 'mondo',
  artifact: 'mondo',
  symbol: 'mondo',
  entity_class: 'mondo',
  glossary_term: 'mondo',
  theme: 'temi',
  motif: 'temi',
  style_rule: 'stile',
  narrative_constraint: 'stile',
  character_voice: 'stile',
};
const KEEP_TAB = new Set<Tab>(['personaggio', 'arco', 'mondo', 'temi', 'stile']);

// Collapsible sidebar sections: which nav group each tab belongs to.
const TAB_GROUP: Record<Tab, string> = {
  romanzo: 'Panoramica', timeline: 'Panoramica', coerenza: 'Panoramica',
  capitolo: 'Entità', personaggio: 'Entità', arco: 'Entità', mondo: 'Entità', temi: 'Entità', stile: 'Entità',
  editoriale: 'Lavoro', search: 'Lavoro', openPoints: 'Lavoro', documents: 'Lavoro', admin: 'Lavoro',
};

// Group a character by its canonical category metadata.
const characterCategory = (node: KgNode): string => metaString(node, 'categoryLabel') ?? 'Altri';
// Group a theme node by its level in doc branch 1.5; motifs get their own bucket.
const themeGroup = (node: KgNode): string => {
  if (node.type === 'motif') return 'Motivi ricorrenti';
  const key = metaString(node, 'primarySectionKey') ?? metaString(node, 'sectionKey') ?? '';
  if (key.startsWith('1.5.1')) return 'Livello 1 — Temi architettonici';
  if (key.startsWith('1.5.2')) return 'Livello 2 — Temi evolutivi';
  if (key.startsWith('1.5.3')) return 'Livello 3 — Temi relazionali';
  if (key.startsWith('1.5.4')) return 'Livello 4 — Temi esistenziali';
  return 'Altri temi';
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

// Collapsible header for a sidebar navigation group.
function NavGroup({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button className={`nav-group${open ? ' open' : ''}`} onClick={onToggle} aria-expanded={open}>
      <ChevronDown size={13} className="nav-caret" />{label}
    </button>
  );
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
          <span className="chapter-num">{chapter.role === 'prologo' ? 'P' : chapter.role === 'epilogo' ? 'E' : (chapter.number ?? '·')}</span>
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
  const numbered = chapters.filter((chapter) => chapter.number != null).length;
  const interludes = chapters.filter((chapter) => chapter.number != null && isFrame(chapter.timePlane)).length;
  const hasPro = chapters.some((chapter) => chapter.role === 'prologo');
  const hasEpi = chapters.some((chapter) => chapter.role === 'epilogo');
  const frameNodes = useMemo(
    () => chapters.filter((chapter) => chapter.frameOrder != null).sort((a, b) => (a.frameOrder ?? 0) - (b.frameOrder ?? 0)),
    [chapters],
  );
  return (
    <div className="novel-panel">
      <div className="novel-head">
        <h2>Vista Romanzo</h2>
        <p className="novel-sub">
          Struttura a cornice · {hasPro ? 'Prologo → ' : ''}<b>{numbered}</b> capitoli ({interludes} interludi cornice){hasEpi ? ' → Epilogo' : ''}.
          Ogni riga apre la Vista Capitolo.
        </p>
      </div>

      {frameNodes.length > 0 && (
        <section className="frame-plane">
          <h3><span className="chapter-plane frame">piano cornice</span> la serata del racconto · Nonno → nipoti, 27/12/2080 <small>{frameNodes.length}</small></h3>
          <p className="novel-note">Sequenza a sé (il tempo del racconto). Ogni interludio resta ancorato anche al punto della storia principale che commenta.</p>
          <div className="frame-rail">
            {frameNodes.map((node, index) => (
              <div className="frame-step" key={node.id}>
                <button className={`frame-card${selectedId === node.id ? ' active' : ''}`} onClick={() => onOpen(node.id)}>
                  <span className="frame-badge">{node.role === 'prologo' ? 'Prologo' : node.role === 'epilogo' ? 'Epilogo' : `Cap ${node.number}`}</span>
                  <span className="frame-title">{node.title}</span>
                  {node.number != null && <span className="frame-point">nel racconto ≈ Cap {node.number}</span>}
                </button>
                {index < frameNodes.length - 1 && <span className="frame-arrow">→</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="chapter-strip">
        {chapters.map((chapter) => (
          <button
            key={chapter.id}
            className={`chapter-row${isFrame(chapter.timePlane) ? ' frame' : ''}${selectedId === chapter.id ? ' active' : ''}`}
            onClick={() => onOpen(chapter.id)}
          >
            <span className="chapter-num">{chapter.role === 'prologo' ? 'P' : chapter.role === 'epilogo' ? 'E' : (chapter.number ?? '·')}</span>
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
  // Prefer the structured `role` metadata (set by the backend for Prologo/Epilogo chapter nodes);
  // fall back to the label regex only for nodes written before that field existed.
  const chapterRole = metaString(chapter, 'role');
  const isBookend = chapterRole === 'prologo' || chapterRole === 'epilogo' || /^(prologo|epilogo)/i.test(chapter.label);
  const number = metaString(chapter, 'chapterNumber');
  const title = metaString(chapter, 'chapterTitle') ?? chapter.label;
  const plane = metaString(chapter, 'timePlane') ?? (isBookend ? 'frame' : null);
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
        <span className="node-type"><span className="dot" style={{ background: colorFor('chapter') }} />{isBookend ? 'cornice · bookend del racconto' : `capitolo · ${isFrame(plane) ? 'cornice' : 'storia principale'}`}</span>
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

// Navigation list grouped under sub-headers (per category / per type / per level).
function GroupedNavList({ nodes, groupOf, order, selectedId, onOpen }: { nodes: KgNode[]; groupOf: (node: KgNode) => string; order?: string[]; selectedId: string | null; onOpen: (node: KgNode) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, KgNode[]>();
    for (const node of nodes) {
      const key = groupOf(node);
      const list = map.get(key) ?? [];
      list.push(node);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.label.localeCompare(b.label));
    const keys = [...map.keys()].sort((a, b) => {
      const ia = order?.indexOf(a) ?? -1;
      const ib = order?.indexOf(b) ?? -1;
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b);
    });
    return keys.map((key) => ({ key, items: map.get(key)! }));
  }, [nodes, groupOf, order]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (key: string): void => setCollapsed((state) => {
    const next = new Set(state);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  return (
    <div className="result-list">
      {groups.map((group) => {
        const open = !collapsed.has(group.key);
        return (
        <div className="nav-group-block" key={group.key}>
          <button className={`nav-sub-head${open ? ' open' : ''}`} onClick={() => toggle(group.key)} aria-expanded={open}>
            <ChevronDown size={12} className="nav-caret" />
            <span>{group.key}</span>
            <b>{group.items.length}</b>
          </button>
          {open && group.items.map((node) => (
            <button key={node.id} className={selectedId === node.id ? 'result active' : 'result'} onClick={() => onOpen(node)}>
              <span className="dot" style={{ background: colorFor(node.type) }} />
              <span className="result-main"><b>{node.label}</b><small>{labelFor(node.type)}</small></span>
            </button>
          ))}
        </div>
        );
      })}
      {!nodes.length && <div className="empty-state">Nessun elemento</div>}
    </div>
  );
}

// Semantic sections for the character sheet: relations bucketed by the connected node type.
const CHAR_SECTIONS: { title: string; types: string[] }[] = [
  { title: 'Temi affrontati', types: ['theme', 'motif'] },
  { title: 'Aspetto e stati nel tempo', types: ['character_state', 'emotional_state', 'knowledge_state', 'character_trait', 'character_wound', 'character_belief', 'character_goal'] },
  { title: 'Poteri', types: ['power'] },
  { title: 'Rivelazioni & segreti', types: ['revelation', 'secret'] },
  { title: 'Fili narrativi', types: ['plot_thread', 'conflict'] },
  { title: 'Momenti nella timeline', types: ['timeline_event'] },
  { title: 'Relazioni', types: ['character', 'relationship_dynamic', 'faction'] },
  { title: 'Voce narrativa', types: ['character_voice'] },
];
const STATE_TYPES = new Set(['character_state', 'emotional_state', 'knowledge_state', 'character_trait', 'character_wound', 'character_belief', 'character_goal']);
const stateDate = (node: KgNode): string | null => metaString(node, 'startDate') ?? metaString(node, 'date') ?? metaString(node, 'dateStart') ?? metaString(node, 'endDate');
const stateSortKey = (node: KgNode): string => stateDate(node) ?? metaString(node, 'primarySectionKey') ?? 'zzzz';

function groupTouches(touches: EntityPacket['touches']): Map<string, EntityPacket['touches']> {
  const grouped = new Map<string, EntityPacket['touches']>();
  for (const relation of touches) {
    const list = grouped.get(relation.kind) ?? [];
    list.push(relation);
    grouped.set(relation.kind, list);
  }
  return grouped;
}

function TouchGroups({ grouped, onOpen, node }: { grouped: Map<string, EntityPacket['touches']>; onOpen: (id: string, type: string) => void; node: KgNode }) {
  return (
    <>
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
    </>
  );
}

function EntityPanel({ packet, onOpen }: { packet: EntityPacket | null; onOpen: (id: string, type: string) => void }) {
  if (!packet?.node) return <div className="graph-empty">Seleziona un elemento</div>;
  const node = packet.node;
  const isCharacter = node.type === 'character';
  const isArc = node.type === 'plot_thread';
  const resolved = packet.touches.some((relation) => RESOLVED_KINDS.has(relation.kind));
  const graph = packetToGraph(node, packet.touches, packet.incomingMentions);
  const category = metaString(node, 'categoryLabel');

  // For characters, bucket related nodes into readable sections by node type; the rest stays grouped by edge kind.
  const usedKeys = new Set<string>();
  const sections = isCharacter
    ? CHAR_SECTIONS.map((section) => {
        const items = packet.touches.filter((relation) => section.types.includes(relation.node.type));
        items.forEach((relation) => usedKeys.add(`${relation.kind}-${relation.node.id}`));
        if (section.title.startsWith('Aspetto')) {
          items.sort((a, b) => stateSortKey(a.node).localeCompare(stateSortKey(b.node)));
        }
        return { title: section.title, items };
      }).filter((section) => section.items.length)
    : [];
  const otherTouches = isCharacter ? packet.touches.filter((relation) => !usedKeys.has(`${relation.kind}-${relation.node.id}`)) : packet.touches;
  const grouped = groupTouches(otherTouches);

  return (
    <div className="novel-panel capitolo">
      <div className="novel-head">
        <span className="node-type"><span className="dot" style={{ background: colorFor(node.type) }} />{labelFor(node.type)}{category ? ` · ${category}` : ''}</span>
        <h2>
          {node.label}
          {isArc && <span className={`arc-status ${resolved ? 'resolved' : 'open'}`}>{resolved ? 'risolto' : 'aperto'}</span>}
        </h2>
      </div>
      {node.content && <p className="node-content">{node.content}</p>}

      {sections.map((section) => (
        <section className="novel-block" key={section.title}>
          <h3>{section.title} <small>{section.items.length}</small></h3>
          <div className="touch-chips">
            {section.items.map((relation) => {
              const date = STATE_TYPES.has(relation.node.type) ? stateDate(relation.node) : null;
              return (
                <button
                  key={`${relation.kind}-${relation.node.id}`}
                  className="pill touch"
                  onClick={() => onOpen(relation.node.id, relation.node.type)}
                >
                  {date && <span className="chip-date">{date}</span>}
                  <span className="dot" style={{ background: colorFor(relation.node.type) }} />
                  {relation.node.label}
                  <small>{labelFor(relation.node.type)}</small>
                </button>
              );
            })}
          </div>
        </section>
      ))}

      <section className="novel-block">
        <h3>{isCharacter ? 'Altri collegamenti' : 'Relazioni & collegamenti'} <small>{otherTouches.length}</small></h3>
        {grouped.size === 0 && <span className="muted">nessun collegamento</span>}
        <TouchGroups grouped={grouped} onOpen={onOpen} node={node} />
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

const MONTHS_IT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
function parseDay(value: string | null): number | null {
  if (!value) return null;
  const iso = value.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
  const dmy = value.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) return Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1]);
  const ym = value.match(/(\d{4})-(\d{2})/);
  if (ym) return Date.UTC(+ym[1], +ym[2] - 1, 1);
  const y = value.match(/\b(19|20)\d{2}\b/);
  if (y) return Date.UTC(+y[0], 0, 1);
  return null;
}

const DAY_MS = 86400000;
const TL_PAD = 64;
const TL_MIN_PPD = 0.5;
const TL_MAX_PPD = 48;
const TL_LANE_H = 20;
const TL_FIXED_H = 400; // fixed timeline canvas height
const dmShort = (day: number): string => `${String(new Date(day).getUTCDate()).padStart(2, '0')}/${String(new Date(day).getUTCMonth() + 1).padStart(2, '0')}`;
const dmFull = (day: number): string => { const d = new Date(day); return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS_IT[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

function TimelinePanel({ entries, onOpenChapter, onOpenEntity }: { entries: TimelineEntry[]; onOpenChapter: (id: string) => void; onOpenEntity: (id: string) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const [pxPerDay, setPxPerDay] = useState(0);
  const [containerW, setContainerW] = useState(0);
  const [cluster, setCluster] = useState<{ x: number; items: { entry: TimelineEntry; day: number }[] } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<{ day: number; clientX: number } | null>(null);
  const ppdRef = useRef(1);
  const minRef = useRef(0);

  const base = useMemo(() => {
    const celestial = entries.filter((entry) => entry.timePlane === 'celestial_past');
    const rest = entries.filter((entry) => entry.timePlane !== 'celestial_past');
    const parsed = rest.map((entry) => ({ entry, day: parseDay(entry.date) }));
    const dated = parsed.filter((p): p is { entry: TimelineEntry; day: number } => p.day != null);
    const frameYear = (day: number): boolean => new Date(day).getUTCFullYear() >= 2050;
    const main = dated.filter((p) => !frameYear(p.day)).sort((a, b) => a.day - b.day || a.entry.label.localeCompare(b.entry.label));
    const frame = dated.filter((p) => frameYear(p.day)).sort((a, b) => a.day - b.day);
    const undated = parsed.filter((p) => p.day == null).map((p) => p.entry);
    const min = main.length ? main[0].day : 0;
    const max = main.length ? main[main.length - 1].day : min + DAY_MS;
    return { main, frame, undated, celestial, min, max, spanDays: Math.max(1, (max - min) / DAY_MS) };
  }, [entries]);

  // Track the real container width (ResizeObserver fires after layout, so clientWidth is valid).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Initial fit-to-width once the container has a measured width.
  useEffect(() => {
    if (pxPerDay > 0 || containerW <= 0) return;
    setPxPerDay(Math.min(TL_MAX_PPD, Math.max(TL_MIN_PPD, (containerW - TL_PAD * 2) / base.spanDays)) || 3);
  }, [containerW, base.spanDays, pxPerDay]);

  const ppd = pxPerDay || 3;
  ppdRef.current = ppd;
  minRef.current = base.min;

  // A stale popover (anchored at an old x) must close when the scale changes.
  useEffect(() => setCluster(null), [ppd]);

  const layout = useMemo(() => {
    // Level-of-detail clustering: events whose markers would touch merge into one cluster.
    // Zooming spreads them so clusters split; a multi-event cluster shows a numbered badge on
    // the spine (always visible) whose popover lists them — no "wall of 8 cards", nothing hidden.
    const evs = base.main.map((p) => ({ entry: p.entry, day: p.day, x: ((p.day - base.min) / DAY_MS) * ppd + TL_PAD }));
    const CLUSTER_GAP = 7;
    const raw: { items: { entry: TimelineEntry; day: number; x: number }[] }[] = [];
    for (const e of evs) {
      const last = raw[raw.length - 1];
      if (last && e.x - last.items[last.items.length - 1].x <= CLUSTER_GAP) last.items.push(e);
      else raw.push({ items: [e] });
    }
    // Fixed-height canvas: the spine sits near the bottom and labels stack UPWARD from it,
    // so the extra height becomes room for many more label lanes (fewer events collapse to badges).
    const spineY = TL_FIXED_H - 44;
    const maxLanes = Math.max(3, Math.floor((spineY - 16) / TL_LANE_H));
    const laneRight: number[] = [];
    const clusters = raw.map((c) => {
      const cx = c.items[0].x;
      let lane = -1;
      if (c.items.length === 1) {
        const labelW = Math.min(240, 62 + c.items[0].entry.label.length * 6.1);
        for (let i = 0; i < laneRight.length; i++) { if (laneRight[i] <= cx - 10) { lane = i; break; } }
        if (lane === -1 && laneRight.length < maxLanes) { lane = laneRight.length; laneRight.push(0); }
        if (lane !== -1) laneRight[lane] = cx + labelW;
      }
      return { cx, items: c.items, lane };
    });
    const width = ((base.max - base.min) / DAY_MS) * ppd + TL_PAD * 2 + 240;
    const ticks: { x: number; label: string; major: boolean }[] = [];
    const dayTicks: number[] = [];
    if (base.main.length) {
      const s = new Date(base.min);
      let cur = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1);
      let first = true;
      while (cur <= base.max + DAY_MS * 31) {
        const d = new Date(cur);
        const x = ((cur - base.min) / DAY_MS) * ppd + TL_PAD;
        const major = d.getUTCMonth() === 0 || first;
        ticks.push({ x, label: major ? `${MONTHS_IT[d.getUTCMonth()]} ${d.getUTCFullYear()}` : MONTHS_IT[d.getUTCMonth()], major });
        cur = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
        first = false;
      }
      if (ppd >= 13) for (let day = base.min; day <= base.max; day += DAY_MS) dayTicks.push(((day - base.min) / DAY_MS) * ppd + TL_PAD);
    }
    return { clusters, spineY, width, height: TL_FIXED_H, ticks, dayTicks };
  }, [base, ppd]);

  // Restore the scroll position so the zoom stays anchored under the cursor / viewport centre.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchorRef.current;
    if (el && a) { el.scrollLeft = ((a.day - base.min) / DAY_MS) * ppd + TL_PAD - a.clientX; anchorRef.current = null; }
  }, [ppd, base.min]);

  // Ctrl/⌘ + wheel to zoom (native non-passive listener so preventDefault works).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const handler = (ev: WheelEvent): void => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      const clientX = ev.clientX - el.getBoundingClientRect().left;
      const day = minRef.current + ((el.scrollLeft + clientX - TL_PAD) / ppdRef.current) * DAY_MS;
      anchorRef.current = { day, clientX };
      setPxPerDay((v) => Math.min(TL_MAX_PPD, Math.max(TL_MIN_PPD, (v || 3) * (ev.deltaY < 0 ? 1.2 : 1 / 1.2))));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  const zoomBtn = (factor: number): void => {
    const el = scrollRef.current;
    const clientX = el ? el.clientWidth / 2 : 300;
    const day = base.min + ((((el?.scrollLeft ?? 0) + clientX) - TL_PAD) / ppd) * DAY_MS;
    anchorRef.current = { day, clientX };
    setPxPerDay((v) => Math.min(TL_MAX_PPD, Math.max(TL_MIN_PPD, (v || 3) * factor)));
  };
  const fit = (): void => {
    const w = containerW || scrollRef.current?.clientWidth || 900;
    anchorRef.current = null;
    setPxPerDay(Math.min(TL_MAX_PPD, Math.max(TL_MIN_PPD, (w - TL_PAD * 2) / base.spanDays)) || 3);
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  };

  const openEntry = (entry: TimelineEntry): void => { if (entry.chapterId) onOpenChapter(entry.chapterId); else onOpenEntity(entry.id); };

  return (
    <div className="novel-panel">
      <div className="novel-head">
        <h2>Timeline del romanzo</h2>
        <p className="novel-sub">
          Cronologia <b>proporzionale</b> della storia principale: gli eventi sono in ordine di data e distanziati secondo il tempo reale (i vuoti tra i beat si vedono). Trascina la barra per scorrere, <b>Ctrl/⌘ + rotellina</b> o i pulsanti per lo zoom. Dove più eventi sono ravvicinati compare sull'asse un <b>pallino numerato</b>: cliccalo per l'elenco completo; <b>zooma</b> per separarli e far riapparire le etichette.
        </p>
      </div>
      <div className="tl2-bar">
        <div className="tl-legend">
          <span><i className="tl-key main" /> storia principale <b>{base.main.length}</b></span>
          {base.frame.length > 0 && <span><i className="tl-key frame" /> cornice 2080 <b>{base.frame.length}</b></span>}
          {base.celestial.length > 0 && <span><i className="tl-key celestial" /> passato celeste <b>{base.celestial.length}</b></span>}
          {base.undated.length > 0 && <span><i className="tl-key none" /> non datati <b>{base.undated.length}</b></span>}
        </div>
        <div className="tl2-zoom">
          {base.main.length > 0 && <span className="tl2-span">{dmFull(base.min)} → {dmFull(base.max)}</span>}
          <button onClick={() => zoomBtn(1 / 1.4)} title="Zoom indietro" aria-label="Zoom indietro">−</button>
          <button onClick={fit} title="Adatta alla finestra">Adatta</button>
          <button onClick={() => zoomBtn(1.4)} title="Zoom avanti" aria-label="Zoom avanti">+</button>
        </div>
      </div>

      {base.main.length > 0 && (
        <div className="tl2-scroll" ref={scrollRef}>
          <div className="tl2-canvas" style={{ width: layout.width, height: layout.height }} onClick={() => setCluster(null)}>
            {layout.ticks.map((t, i) => {
              const next = layout.ticks[i + 1]?.x ?? layout.width;
              return (
                <div key={`m${i}`}>
                  {i % 2 === 0 && <div className="tl2-band" style={{ left: t.x, width: next - t.x, height: layout.spineY }} />}
                  <div className={`tl2-grid${t.major ? ' major' : ''}`} style={{ left: t.x, height: layout.spineY }} />
                  <div className="tl2-monthlab" style={{ left: t.x, top: layout.spineY + 7 }}>{t.label}</div>
                </div>
              );
            })}
            {layout.dayTicks.map((x, i) => <div key={`d${i}`} className="tl2-daytick" style={{ left: x, height: layout.spineY }} />)}
            <div className="tl2-spine" style={{ top: layout.spineY, left: TL_PAD - 10, width: layout.width - (TL_PAD - 10) - 220 }} />
            {layout.clusters.map((c, i) => {
              const first = c.items[0];
              const multi = c.items.length > 1;
              const active = hover === first.entry.id;
              const cardTop = layout.spineY - (c.lane + 1) * TL_LANE_H - 4;
              const open = (ev: { stopPropagation: () => void }): void => {
                ev.stopPropagation();
                if (multi) setCluster({ x: c.cx, items: c.items.map((it) => ({ entry: it.entry, day: it.day })) });
                else openEntry(first.entry);
              };
              return (
                <div key={`cl${i}`}>
                  {!multi && c.lane >= 0 && <div className="tl2-conn" style={{ left: c.cx, top: cardTop + 17, height: layout.spineY - (cardTop + 17) }} />}
                  {!multi && c.lane >= 0 && (
                    <button
                      className={`tl2-card${active ? ' active' : ''}`}
                      style={{ left: c.cx, top: cardTop }}
                      onMouseEnter={() => setHover(first.entry.id)}
                      onMouseLeave={() => setHover((h) => (h === first.entry.id ? null : h))}
                      onClick={open}
                      title={`${first.entry.label} — ${dmFull(first.day)}${first.entry.chapterId ? ` · Cap ${first.entry.chapterNumber ?? '·'}` : ''}`}
                    >
                      <span className="tl2-card-d">{dmShort(first.day)}</span>
                      <span className="tl2-card-t">{first.entry.label}</span>
                    </button>
                  )}
                  {multi ? (
                    <button
                      className="tl2-badge"
                      style={{ left: c.cx, top: layout.spineY }}
                      onClick={open}
                      title={`${c.items.length} eventi ravvicinati (${dmShort(first.day)}–${dmShort(c.items[c.items.length - 1].day)}) — clicca per l'elenco`}
                    >{c.items.length}</button>
                  ) : (
                    <button
                      className={`tl2-dot${active ? ' active' : ''}${first.entry.chapterId ? '' : ' free'}`}
                      style={{ left: c.cx, top: layout.spineY }}
                      onMouseEnter={() => setHover(first.entry.id)}
                      onMouseLeave={() => setHover((h) => (h === first.entry.id ? null : h))}
                      onClick={open}
                      title={`${first.entry.label} — ${dmFull(first.day)}`}
                      aria-label={`${first.entry.label} — ${dmFull(first.day)}`}
                    />
                  )}
                </div>
              );
            })}
            {cluster && (
              <div className="tl2-pop" style={{ left: Math.max(4, Math.min(cluster.x, layout.width - 278)), top: 8 }} onClick={(ev) => ev.stopPropagation()}>
                <div className="tl2-pop-h">
                  <b>{cluster.items.length} eventi ravvicinati</b>
                  <button className="tl2-pop-x" onClick={() => setCluster(null)} aria-label="Chiudi">×</button>
                </div>
                <div className="tl2-pop-list">
                  {cluster.items.map((it) => (
                    <button key={it.entry.id} className="tl2-pop-row" onClick={() => { openEntry(it.entry); setCluster(null); }}>
                      <span className="tl2-card-d">{dmShort(it.day)}</span>
                      <span className="tl2-pop-t">{it.entry.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {base.frame.length > 0 && (
        <section className="novel-block">
          <h3><span className="chapter-plane frame">cornice</span> 2080 <small>{base.frame.length}</small></h3>
          <div className="tl-frame-rail">
            {base.frame.map((p) => (
              <button key={p.entry.id} className="tl-chip frame" onClick={() => openEntry(p.entry)}>
                <span className="tl-chip-date">{p.entry.date ?? '—'}</span>
                {p.entry.label}
              </button>
            ))}
          </div>
        </section>
      )}

      {base.celestial.length > 0 && (
        <section className="novel-block">
          <h3><span className="chapter-plane celestial">passato celeste</span> pre-storia <small>{base.celestial.length}</small></h3>
          <p className="novel-note">Eventi del passato angelico (pre-2020) fuori dalla cronologia terrena: si "sbloccano" quando i personaggi ne prendono consapevolezza. Collegati a Gabriel/Lisa e ancorati via <span className="edge-kind">revealed_in</span> al capitolo della rivelazione.</p>
          <div className="tl-frame-rail">
            {base.celestial.map((entry) => (
              <button key={entry.id} className="tl-chip celestial" onClick={() => openEntry(entry)}>{entry.label}</button>
            ))}
          </div>
        </section>
      )}

      {base.undated.length > 0 && (
        <section className="novel-block">
          <h3>Eventi non datati <small>{base.undated.length}</small></h3>
          <p className="novel-note">Senza data derivabile dal capitolo collegato — candidati alla bonifica (ancoraggio a un capitolo).</p>
          <div className="tl-frame-rail">
            {base.undated.slice(0, 60).map((entry) => (
              <button key={entry.id} className="tl-chip none" onClick={() => openEntry(entry)}>{entry.label}</button>
            ))}
            {base.undated.length > 60 && <span className="muted">+{base.undated.length - 60} altri</span>}
          </div>
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

const PROMPT_GROUPS: { group: string; prompts: { id: string; title: string; body: string }[] }[] = [
  {
    group: 'Preparazione & contesto',
    prompts: [
      { id: 'ctx-cap', title: 'Context packet del capitolo', body: 'Usando il modello neurale (MCP Romanzo_Gabriele: novel_recall_context / kg_search / kg_neighbors), preparami il context packet completo per scrivere il {CAPITOLO}: beat e sinossi canonici, personaggi coinvolti con caratterizzazione, voce e aspetto, eventi di timeline e date pertinenti, regole di mondo (world_rule) e vincoli narrativi (narrative_constraint) applicabili, regole di stile/POV (style_rule), fili narrativi (plot_thread) da chiudere o seminare, e i riferimenti (mentions) collegati. Elenca infine le incongruenze potenziali da evitare.' },
      { id: 'load-char-point', title: 'Carica un personaggio a un punto della storia', body: 'Dammi lo stato canonico di {PERSONAGGIO} esattamente al momento «{MOMENTO}» (es. "Cap. 17" o "05/10/2020"): aspetto fisico in quel momento, stato emotivo, conoscenze/consapevolezza (cosa sa e cosa ignora), poteri disponibili, relazioni attive e loro tono. Ricava tutto dai character_state / emotional_state / knowledge_state ancorati a quella data nel grafo; non inventare nulla oltre il canone.' },
      { id: 'load-story-ctx', title: 'Carica il contesto della storia a un punto', body: 'Ricostruisci il contesto della storia al momento «{MOMENTO}»: quali capitoli lo precedono, quali eventi di timeline sono già avvenuti, lo stato dei fili narrativi aperti, chi sa cosa, e i vincoli di worldbuilding attivi. Usa gli strumenti MCP per leggere dal grafo e cita i nodi/date.' },
    ],
  },
  {
    group: 'Personaggi vivi (impersonazione)',
    prompts: [
      { id: 'impersona', title: 'Impersona un personaggio in una scena', body: 'Impersona {PERSONAGGIO} attenendoti rigorosamente alla sua natura canonica nel modello neurale (personalità, valori, voce, aspetto, arco, relazioni e stato al momento della scena). Scena: «{SCENA}». Come agisce, cosa pensa, cosa dice? Resta in personaggio e segnala se qualcosa nella scena lo forzerebbe fuori carattere.' },
      { id: 'interazione', title: 'Fai interagire due personaggi', body: 'Fai interagire {PERSONAGGIO} e {ALTRO_PERSONAGGIO} come due agenti distinti, ciascuno fedele alla propria caratterizzazione canonica e al proprio stato in quel punto della storia. Contesto: «{SCENA}». Improvvisate dialogo e azione per far emergere le dinamiche autentiche (potere, affetto, conflitto). Alla fine sintetizza cosa insegna questa interazione su come scrivere la scena.' },
      { id: 'autovaluta', title: 'Il personaggio si valuta nel capitolo', body: 'Impersona {PERSONAGGIO} e leggi il testo del {CAPITOLO} qui incollato. Ti riconosci? Indica i punti in cui NON ti riconosci (battute, reazioni, pensieri fuori carattere) citando il testo, e proponi come riscriverli per essere fedele alla tua vera natura canonica. Elenca 3–7 feedback puntuali e concreti.' },
    ],
  },
  {
    group: 'Revisione & verifica',
    prompts: [
      { id: 'assi5', title: 'Revisione sui 5 assi', body: 'Valuta la bozza del {CAPITOLO} (incollata sotto) contro il modello consolidato sui 5 assi: (1) coerenza col canone, (2) ridondanza vs capitoli già scritti, (3) antipattern narrativi, (4) aderenza di stile/POV alle style_rule, (5) cronologia/date. Per ogni rilievo indica: severità, citazione dal testo, riferimento al canone (nodo/sezione), fix proposto.' },
      { id: 'aspetto', title: 'Coerenza descrittiva dell’aspetto', body: 'Verifica che l’aspetto fisico di {PERSONAGGIO} nel testo incollato sia coerente al 100% con la descrizione canonica nel modello neurale. Per il Nonno: l’aspetto deve essere IDENTICO in ogni scena di cornice (Prologo, Interludi, Epilogo). Segnala ogni discrepanza con citazione del testo e correzione basata sul canone.' },
      { id: 'verifica-elemento', title: 'Verifica un elemento contro TUTTO il modello', body: 'Prima di affermare qualsiasi cosa su «{ELEMENTO}», verificalo contro l’INTERO modello neurale usando gli strumenti MCP (kg_search, kg_neighbors, kg_get_node): trova TUTTE le occorrenze, gli archi e i vincoli collegati, e controlla la coerenza temporale e causale. Esempio di errore da evitare: dire che il ciondolo del Nonno non poteva essere visto la sera del Prologo, quando nel modello quel ciondolo viene mostrato alle nipoti nell’Epilogo — la stessa sera (27/12/2080). NON dedurre nulla che non sia verificato nel grafo; se un’affermazione contraddice il modello, dillo esplicitamente citando i nodi/archi coinvolti.' },
      { id: 'prosa-canon', title: 'Estrazione prosa → canone', body: 'Dalla versione approvata del {CAPITOLO} estrai i nuovi dettagli canonici emersi nella prosa (fatti, oggetti, luoghi, relazioni, date, stati dei personaggi) usando il modello neurale (MCP Romanzo_Gabriele: novel_extract_chapter_candidates). I candidati sono dati, mai nodi del grafo. Passali a novel_commit_chapter_candidates: valida ogni candidato SOLO contro il resto del canone già consolidato (mai contro bozze precedenti di questo capitolo, che non esistono per costruzione) con un gate sia lessicale sia semantico; se segnala discrepanze bloccanti, elencale e attendi conferma prima di procedere.' },
    ],
  },
];

const STYLE_MODIFIER = 'Art Style: Digital illustrative painting with a semi-realistic, \'lived-in\' aesthetic. Texture & Technique: Visible painterly brushstrokes, soft edges, highly detailed clutter (maximalist environmental storytelling). Lighting: Warm, localized tungsten lighting (like a desk lamp) creating a cozy, intimate atmosphere. High contrast chiaroscuro: golden highlights on the subject vs. deep, rich shadows in the corners. Color Palette: Earthy tones (mahogany, ochre, warm beige) mixed with deep blues and midnight tones for the shadows. Mood: Nostalgic, introspective, quiet, studio-ghibli-esque attention to small details (books, posters, messy desk). Composition: Depth of field focused on the subject, with a background filled with narrative objects (posters, notes, stationery).';

// Pipeline editoriale ridisegnata (neural-native): il modello interroga il grafo via MCP
// invece di rileggere la Bibbia come file statico. {SEZIONE}/{N} sono sostituiti alla copia.
// `paths` indica se la fase appartiene al percorso Revisione, Stesura diretta, o a entrambi:
// una revisione parte da un testo esistente, una stesura diretta lo scrive da zero dalla Bibbia.
type EditorialPath = 'revisione' | 'stesura';
const EDITORIAL_STEPS: { id: string; n: string; title: string; role: string; neural: string; body: string; paths: EditorialPath[] }[] = [
  {
    id: 'ctx', n: '0', title: 'Context packet', role: 'preparazione dal grafo', paths: ['revisione', 'stesura'],
    neural: 'Invece di rileggere tutta la Bibbia: interroga il modello neurale solo per il canone pertinente a questa sezione.',
    body: 'VINCOLANTE: se definisco specifiche operative, applicale in modo puntuale; ignorarle è un errore operativo, non una scelta creativa.\n\nPrima di lavorare {SEZIONE}, costruisci il CONTEXT PACKET interrogando il modello neurale (MCP Romanzo_Gabriele: novel_get_chapter_context_packet oppure kg_search/kg_neighbors). Estrai SOLO il canone pertinente: personaggi coinvolti col loro STATO al momento (aspetto fisico, stato emotivo, cosa sanno/ignorano — character_state/emotional_state/knowledge_state datati); eventi di timeline e date; regole di mondo (world_rule) e vincoli narrativi (narrative_constraint); regole di stile/POV (style_rule); voci dei personaggi (character_voice); fili narrativi (plot_thread) da chiudere o seminare; riferimenti (mentions) e temi affrontati. NON rileggere l\'intera Bibbia: interroga il grafo in modo mirato. Riporta il packet schematizzato per aree tematiche.',
  },
  {
    id: 'stesura', n: '0.5', title: 'Stesura da Bibbia', role: 'prima bozza dal solo canone', paths: ['stesura'],
    neural: 'Nessun testo esistente: la Bibbia/il grafo sono l\'unica fonte per la prima bozza.',
    body: 'VINCOLANTE: applica le specifiche in modo puntuale; ignorarle è un errore operativo.\n\nNon esiste ancora un testo per {SEZIONE}: usa ESCLUSIVAMENTE il context packet appena costruito (Fase 0) come fonte per la prima bozza. Scrivi {SEZIONE} rispettando rigorosamente: il canone esistente (nessun elemento fuori Bibbia/grafo); lo stato e la voce di ogni personaggio esattamente al momento della scena (character_state/character_voice datati); le regole di mondo e i vincoli narrativi; lo stile/POV da style_rule; i fili narrativi da seminare o chiudere secondo il context packet. DIVIETO: inventare fatti, oggetti, luoghi o relazioni non presenti nel modello neurale — se serve un dettaglio non ancora canonico, segnalalo come ipotesi e chiedi conferma invece di darlo per assodato. OUTPUT: la prima bozza completa di {SEZIONE}, pronta per le fasi successive come se fosse un testo già esistente da revisionare.',
  },
  {
    id: 'continuity', n: '1', title: 'Continuity & Story Architect', role: 'trama a prova di proiettile', paths: ['revisione', 'stesura'],
    neural: 'Incrocia la bozza col GRAFO (non col file): gli stati evolutivi dei personaggi sono già nodi datati.',
    body: 'VINCOLANTE: applica le specifiche in modo puntuale; ignorarle è un errore operativo.\n\nAgisci come Continuity Editor & Story Architect. Con il context packet di {SEZIONE} (dal modello neurale) come ground truth e i capitoli precedenti come manoscritto, analizza il testo che incollo sotto e verifica: rispetto assoluto della timeline; coerenza con gli STATI EVOLUTIVI dei personaggi (es. Trevor fase X, Gabriele con/senza occhiali — leggili dai character_state datati nel grafo); coerenza con tutti gli elementi canonici; assenza di ridondanze intra- e inter-capitolo; plot hole (chi sa cose che non dovrebbe, oggetti che appaiono/scompaiono, comportamenti fuori scheda); coerenza temporale/spaziale/caratteriale/fattuale; fluidità delle giunzioni; funzione narrativa (fa avanzare la storia o è riempitivo?). OUTPUT: report a semaforo — 🔴 ROSSO (contraddizioni col canone/passato), 🟡 GIALLO (ripetizioni/rallentamenti), 🟢 VERDE (rafforza la trama orizzontale). Cita SEMPRE il nodo/arco del grafo a supporto; non affermare nulla che non sia verificato nel modello.',
  },
  {
    id: 'style', n: '2', title: 'Editor stilistico', role: 'audit riga per riga', paths: ['revisione', 'stesura'],
    neural: 'Allinea stile/voce/POV alle style_rule e character_voice del grafo.',
    body: 'VINCOLANTE: applica le specifiche in modo puntuale; ignorarle è un errore operativo.\n\nAgisci come Editor tecnico e stilistico inflessibile, obiettivo best-seller. NON riscrivere ora. Se il testo di {SEZIONE} supera 2500 parole, suddividilo in blocchi ≤2500 parole ed elencali (il focus lo garantisce il canone del grafo, non la dimensione del blocco: preferisci il testo intero o pochi blocchi ampi) (numero blocco, n. parole, frase di inizio, frase di fine). Per ogni blocco produci una TABELLA DI INTERVENTO esaustiva, senza tralasciare nulla: ID univoco | Testo originale | Problema rilevato | Suggerimento specifico. Copri: grammatica/sintassi (frasi contorte, refusi), ripetizioni lessicali/concettuali, tell-invece-di-show, ritmo (punti morti/troppo veloci), dialoghi innaturali, avverbi inutili. Allinea voce/POV/lessico alle style_rule e character_voice del modello neurale.',
  },
  {
    id: 'ghost', n: '3', title: 'Ghost Writer', role: 'riscrittura dei blocchi', paths: ['revisione', 'stesura'],
    neural: 'Rispetta voce/carattere/stato evolutivo di ogni personaggio letti dal grafo.',
    body: 'VINCOLANTE: applica le specifiche in modo puntuale; ignorarle è un errore operativo.\n\nAgisci come Senior Ghost Writer. Riscrivi il blocco corrente di {SEZIONE} applicando TUTTI i punti della tabella, mantenendo intatta la voce narrante e lo stile; rispetta voce, carattere e STATO EVOLUTIVO di ogni personaggio (dal grafo). DIVIETI: aggiungere elementi non canonici; sconfinare in blocchi diversi da quello corrente; taglia-incolla di frasi dalla tabella; produrre un riassunto del blocco. GATE LUNGHEZZA: il testo in output deve stare tra l\'85% e il 140% del blocco originale; se sfori, hai proseguito la narrazione o violato un divieto — identifica quale e rifai finché non rientri. OUTPUT: solo il testo finale del blocco, pronto alla pubblicazione + nota di come hai applicato ciascun punto della tabella.',
  },
  {
    id: 'seam', n: '4', title: 'Saldature & ridondanza', role: 'cuciture invisibili', paths: ['revisione', 'stesura'],
    neural: 'Confronto differenziale col manoscritto (nodi capitolo); con embeddings attivi diventa semantico.',
    body: 'VINCOLANTE: applica le specifiche in modo puntuale; ignorarle è un errore operativo.\n\nAgisci come Supervisore stilistico. Sul capitolo {SEZIONE} assemblato: (1) rendi INVISIBILI le saldature tra blocchi (riscrivi solo le frasi di raccordo dove serve); (2) verifica coerenza interna inizio↔fine e costanza di tono/atmosfera/registro; (3) verifica che la voce dei personaggi sia credibile, non caricaturale, e rispetti il loro climax emotivo. Poi ANALISI DIFFERENZIALE vs il resto del manoscritto (capitoli precedenti nel grafo): segnala descrizioni fisiche ripetute (aggettivi/frasi già usati), tic linguistici abusati, info-dumping (fatti/retroscena già noti al lettore rispiegati), e coerenza immediata col finale del capitolo precedente (giorno/notte, posizioni, luogo). Se nessun problema: spiega l\'analisi e scrivi "CAPITOLO APPROVATO". Altrimenti elenca puntualmente tutti i fix.',
  },
  {
    id: 'impact', n: '4.5', title: 'Scansione impatto revisione', role: 'nodi da rivedere prima di chiudere', paths: ['revisione'],
    neural: 'Cammina il grafo dal fatto cambiato: mai propagare a cascata in automatico e in silenzio.',
    body: 'VINCOLANTE: applica le specifiche in modo puntuale; ignorarle è un errore operativo.\n\nSolo perché {SEZIONE} aggiorna un fatto canonico già registrato (non una prima stesura): prima di proseguire, richiama il modello neurale (MCP Romanzo_Gabriele: novel_scan_revision_impact) indicando ogni fatto cambiato rispetto alla versione precedente. Esamina il report: nodi potenzialmente impattati (personaggi, eventi, fili narrativi collegati) ed eventuali conflitti diretti di polarità (es. "sa"/"non sa"). NON riscrivere nulla automaticamente: elenca i nodi da rivedere e chiedi conferma esplicita prima di chiudere la sessione di editing. Se il report non segnala nulla, dichiaralo esplicitamente e prosegui.',
  },
  {
    id: 'line', n: '5', title: 'Line editor & impaginazione', role: 'fluidità + tipografia', paths: ['revisione', 'stesura'],
    neural: 'Formattazione editoriale standard; output solo testo finale.',
    body: 'VINCOLANTE: applica le specifiche in modo puntuale; ignorarle è un errore operativo.\n\nAgisci come Senior Line Editor & Typesetter. FASE 1 — fluidità: analizza ogni frase in relazione alla precedente/successiva, inserisci leganti logici dove il testo è slegato, alterna frasi brevi e lunghe (mantieni lo stile dell\'autore), spezza i muri di testo con a-capo logici. FASE 2 — formattazione tipografica: ogni battuta di dialogo di un personaggio DIVERSO va su NUOVA RIGA; a-capo pulito a fine di ogni paragrafo logico; elimina i doppi spazi. Verifica che ogni frase sia di senso compiuto (niente frasi che si interrompono in aria, modi di dire corretti). OUTPUT: SOLO il testo finale revisionato e impaginato di {SEZIONE}, nient\'altro.',
  },
  {
    id: 'art', n: '6', title: 'Art Director', role: 'key visual + immagine', paths: ['revisione', 'stesura'],
    neural: 'Recupera l\'aspetto canonico dei personaggi AL MOMENTO GIUSTO (character_state datati).',
    body: 'VINCOLANTE: applica le specifiche in modo puntuale; ignorarle è un errore operativo.\n\nAgisci come Direttore della fotografia & Concept Artist. Dal testo di {SEZIONE}: (1) individua il KEY VISUAL MOMENT (il momento più evocativo/rappresentativo); (2) recupera dal modello neurale l\'aspetto CANONICO dei personaggi della scena AL MOMENTO GIUSTO della loro evoluzione (character_state datati: es. Gabriele con/senza occhiali, colore occhi, fisico) + oggetti e luoghi menzionati + illuminazione implicita; (3) costruisci il prompt come [DESCRIZIONE DETTAGLIATA DELLA SCENA] + [STYLE MODIFIER immutabile]. OUTPUT: "Ho identificato la scena: …"; elementi descrittivi dei personaggi recuperati dal grafo; prompt completo in ITALIANO e in INGLESE ottimizzato per IA; genera direttamente l\'immagine.\n\nSTYLE MODIFIER (immutabile, sempre in coda): ' + STYLE_MODIFIER,
  },
  {
    id: 'ingest', n: '7', title: 'Ingestion prosa → canone', role: 'chiude il ciclo di apprendimento', paths: ['revisione', 'stesura'],
    neural: 'I fatti del testo finale diventano nodi/archi validati contro il resto del canone, mai contro bozze precedenti: i capitoli successivi non saranno ridondanti né incoerenti.',
    body: 'VINCOLANTE: applica le specifiche in modo puntuale; ignorarle è un errore operativo.\n\nChiuso l\'editing di {SEZIONE}, estrai dalla versione FINALE i nuovi dettagli canonici emersi nella prosa (descrizioni, oggetti, luoghi, episodi, ricordi, relazioni, date, nuovi stati fisici/emotivi/di conoscenza dei personaggi) con il modello neurale (MCP Romanzo_Gabriele: novel_extract_chapter_candidates). I candidati sono dati, mai nodi del grafo. Passali a novel_commit_chapter_candidates: valida ogni candidato SOLO contro il resto del canone già consolidato (Bibbia + capitoli già canonizzati) — mai contro bozze precedenti di questa stessa sezione, che non esistono per costruzione — con un gate sia lessicale sia semantico (embeddings); se segnala discrepanze bloccanti, elenca i conflitti e attendi conferma prima di procedere. Solo dopo l\'ok, finalizza con novel_save_final_chapter, che aggiorna in place il nodo canonico di {SEZIONE} (mai una bozza separata). Obiettivo: mantenere il modello aggiornato così che i capitoli successivi non siano ridondanti né in contraddizione con quanto già consolidato.',
  },
];

// Workflow guidato passo-passo (Processo A = revisione di un testo esistente, Processo B =
// stesura generata dal solo canone): sequenza di prompt da lanciare in ordine, uno per turno,
// in un'unica chat dedicata alla sezione. Autogenerati sulla sezione scelta: Prologo/Epilogo
// usano `role`, i capitoli numerati `chapterNumber` (i tool MCP accettano l'uno o l'altro).
// I token fra parentesi angolari (<sessionId>, <N>, …) si compilano durante la chat.
interface WorkflowStep { code: string; title: string; hint: string; body: string }
function buildWorkflowPrompts(path: EditorialPath, chapter: ChapterSummary | null): WorkflowStep[] {
  const role = chapter?.role === 'prologo' ? 'prologo' : chapter?.role === 'epilogo' ? 'epilogo' : null;
  const numbered = Boolean(chapter && !role && chapter.number !== null);
  const phrase = !chapter
    ? 'la sezione scelta (capitolo/Prologo/Epilogo)'
    : role === 'prologo' ? 'il Prologo' : role === 'epilogo' ? "l'Epilogo" : `il Capitolo ${chapter.number} «${chapter.title}»`;
  const ident = role
    ? `role: "${role}"`
    : numbered ? `chapterNumber: ${chapter!.number}` : 'chapterNumber: <N> (oppure role: "prologo"/"epilogo")';
  const titleArg = chapter?.title ? `, title: "${chapter.title}"` : '';
  const steps: WorkflowStep[] = [];
  const add = (code: string, title: string, hint: string, body: string): void => { steps.push({ code, title, hint, body }); };

  const preflightExtra = path === 'stesura'
    ? ` In più: identifica dal grafo i personaggi che compaiono in ${phrase} e verifica se le loro sezioni Bibbia di voce/psicologia ("Linguaggio e 'Voce'", "Evoluzione", "Controlli Operativi per Scrittura AI") risultano tra le sezioni non mappate del coverage report. Se sì, segnalamelo: decido io se completare prima il mapping o procedere comunque.`
    : '';
  add(path === 'stesura' ? 'B0' : 'A0', 'Pre-flight check', 'stato del modello prima di partire',
    `Esegui il pre-flight check per lavorare ${phrase}: chiama get_server_status, kg_embedding_status e novel_bible_coverage_report; leggi anche kg_list_open_questions per eventuali domande aperte pertinenti a questa sezione. Confermami che: Neo4j è connesso, gli embeddings sono completi (0 pending), pendingCandidates=0 e non ci sono finding di severità error. Se emerge un error, fermati e riportamelo senza procedere.${preflightExtra}`);

  if (path === 'stesura') {
    add('B1', 'Dossier di scrittura', 'solo canone dal grafo, nessuna invenzione',
      `Prepara il dossier completo per scrivere ${phrase} usando SOLO il grafo: novel_get_chapter_context_packet (task: "stesura ${phrase}", ${ident}); kg_get_node del nodo chapter e kg_neighbors (depth 2) per eventi, thread e vincoli collegati; novel_recall_context sui personaggi coinvolti (stato emotivo, knowledge_state — chi sa cosa in questo punto della storia —, relationship_dynamic, voce); kg_search su style_rule, motif e narrative_constraint applicabili; cronologia con eventi immediatamente precedenti e successivi (archi precedes). Restituiscimi il dossier strutturato: scene attese dalla Bibbia, personaggi con stato e voce al momento della scena, vincoli non negoziabili, cosa NON può ancora essere rivelato al lettore, aggancio con la sezione precedente e successiva. Dichiara esplicitamente ogni punto in cui la Bibbia è silente: lì NON inventare canone, segnalami la scelta narrativa come proposta.`);
    add('B2', 'Sessione + prima bozza', 'l’IA scrive dal dossier, fuori-Bibbia vietato',
      `Apri la sessione con novel_start_editing_session (${ident}${titleArg}) e riportami il sessionId. Poi scrivi la PRIMA BOZZA completa di ${phrase} rispettando rigorosamente il dossier del prompt precedente: nessun elemento fuori Bibbia, stato e voce dei personaggi al momento della scena, vincoli di rivelazione, stile e motivi del romanzo, lunghezza adeguata alle altre sezioni. Le micro-scelte non coperte dalla Bibbia (dettagli sensoriali, battute minori) sono ammesse solo se canonicamente neutre: elencale a fine bozza in una sezione "Proposte non canoniche" così le valido. Presentami la bozza integrale.`);
    add('B3', 'Bozza in blocchi', numbered ? 'ingest come materiale di lavoro + split' : 'split diretto (Prologo/Epilogo: niente ingest)',
      numbered
        ? `Ho letto la bozza e voglio procedere <eventuali modifiche preliminari>. Registrala come materiale di lavoro con novel_ingest_chapter_draft (chapterNumber: ${chapter!.number}, title, content, status: "draft") e poi suddividila nella sessione con novel_split_chapter_blocks (sessionId <sessionId>, persist: true, maxWords 2500 — se il testo sta in un blocco unico, tienilo intero: il focus lo garantisce il canone del grafo, non la dimensione del blocco). Riportami blocchi e conteggi. Ricorda: la bozza NON è canone.`
        : `Ho letto la bozza e voglio procedere <eventuali modifiche preliminari>. Per ${phrase} novel_ingest_chapter_draft non è disponibile (accetta solo capitoli numerati): suddividi direttamente il testo nella sessione con novel_split_chapter_blocks (sessionId <sessionId>, content: <testo della bozza>, persist: true, maxWords 2500 — se il testo sta in un blocco unico, tienilo intero). Riportami blocchi e conteggi. Ricorda: la bozza NON è canone.`);
    add('B4', 'Auto-revisione continuity', 'il modello fa il revisore severo di sé stesso',
      `Ora fai il revisore del tuo stesso testo, con massima severità. Esegui lo step di CONTINUITY blocco per blocco confrontando la bozza con il grafo (kg_recall, kg_semantic_search${numbered ? `) e con novel_audit_chapter (chapterNumber: ${chapter!.number}, content: <bozza>)` : ') — per questa sezione novel_audit_chapter non è disponibile, usa il confronto diretto col canone'}. Cerca in particolare gli errori tipici della generazione: fatti inventati non presenti in Bibbia, personaggi che sanno cose che a questo punto non sanno (knowledge_state), anacronismi, violazioni di narrative_constraint, anticipazioni vietate. Estendi la verifica CROSS-CAPITOLO via kg_semantic_search: scene o formulazioni troppo simili a capitoli già canonizzati (ridondanza sull'intero romanzo) e aggancio corretto con capitolo precedente/successivo. Registra tutto con novel_save_editorial_findings (sessionId <sessionId>) e riportami la tabella dei finding.`);
  } else {
    add('A1', 'Sessione + contesto canonico', 'apre la sessione e carica i vincoli dal grafo',
      `Apri la sessione editoriale per ${phrase} con novel_start_editing_session (${ident}${titleArg}) e riportami il sessionId. Poi raccogli il contesto canonico completo per la revisione: novel_get_chapter_context_packet (task: "revisione ${phrase}", ${ident}) e novel_recall_context / kg_recall su personaggi, luoghi, oggetti simbolici e vincoli della sezione. Sintetizzami i vincoli canonici vigenti: cronologia e date, stati di conoscenza (chi sa cosa), oggetti simbolici, regole della cornice narrativa se pertinenti (per il Prologo: la narratorCoverageRule del Nonno — mai rivelare che è la sua storia prima dell'Epilogo), atmosfera e voce. Non inventare nulla che non sia nel grafo.`);
    add('A2', 'Testo in blocchi', 'carica il testo esistente e lo suddivide',
      `Ti fornisco il testo di ${phrase} da revisionare. ${numbered ? `Registralo prima come materiale di lavoro con novel_ingest_chapter_draft (chapterNumber: ${chapter!.number}, title, content, status: "draft"), poi u` : `Per questa sezione novel_ingest_chapter_draft non è disponibile (accetta solo capitoli numerati): u`}sa novel_split_chapter_blocks sulla sessione <sessionId> con il testo completo, maxWords 2500 e persist: true (se il testo sta in un blocco unico, tienilo intero: il focus lo garantisce il canone del grafo, non la dimensione del blocco). Riportami l'elenco dei blocchi (numero, prime parole, conteggio parole) e conferma che la somma ricostruisce l'intero testo.\n\n<incolla qui il testo integrale>`);
    add('A3', 'Revisione continuity', 'confronto blocco per blocco col canone',
      `Esegui lo step di CONTINUITY su ${phrase}, blocco per blocco. Per ogni blocco confronta il testo con il canone del grafo (kg_recall, kg_semantic_search e i vincoli raccolti al prompt precedente) e verifica: date e cronologia, età e caratterizzazione dei personaggi, coerenza degli oggetti simbolici, stati di conoscenza (nessuno sa cose che a questo punto non sa), assenza di anticipazioni/spoiler vietati dalla Bibbia. Estendi la verifica CROSS-CAPITOLO: i capitoli già canonizzati sono nel grafo con embeddings — usa kg_semantic_search sui passaggi chiave del blocco per trovare scene simili in altri capitoli e verifica continuità (stati dei personaggi tra capitolo precedente e successivo) e non-ridondanza sull'intero romanzo. Registra ogni problema con novel_save_editorial_findings sulla sessione <sessionId> (categoria continuity, con blockNumber, severità, descrizione e proposta di fix). Riportami la tabella dei finding.`);
  }

  add(path === 'stesura' ? 'B5' : 'A4', 'Revisione stilistica', 'style_rule, voce, ritmo, dialoghi',
    `Esegui lo step di STILE su ${phrase}, blocco per blocco, applicando le style_rule e i motivi ricorrenti presenti nel grafo (recuperali con kg_search type "style_rule" e type "motif"): voce del narratore, POV, ritmo, ripetizioni, dialoghi credibili per età e carattere, gestione del mistero senza spiegoni. Registra i finding con novel_save_editorial_findings (categorie style/voice/pacing), senza riscrivere ancora nulla. Riportami l'elenco completo dei finding aperti (continuity + stile) con il loro findingId.`);
  add(path === 'stesura' ? 'B6' : 'A5', 'Decisioni dell’utente', 'approvi/rifiuti/rinvii ogni finding',
    `Ecco le mie decisioni sui finding: <per ogni findingId: approved / rejected / deferred, con eventuale nota>. Registrale con novel_save_user_decisions sulla sessione <sessionId> e confermami il quadro: quanti finding approvati andranno applicati in riscrittura, quanti rifiutati, quanti rinviati.`);
  add(path === 'stesura' ? 'B7' : 'A6', 'Riscrittura blocco per blocco', 'gate 85%–140% enforced dal tool',
    `Riscrivi il blocco <numeroBlocco> di ${phrase} applicando SOLO i finding approvati che lo riguardano. Vincoli: lunghezza tra 85% e 140% dell'originale (enforced dal tool), nessun fatto nuovo fuori canone, voce e tono invariati. Salva con novel_save_rewrite_block (sessionId <sessionId>, blockNumber <numeroBlocco>, originalText, revisedText, appliedFindingIds, approved: false) e mostrami il diff sintetico originale→revisione con la percentuale di lunghezza. Attendi la mia approvazione prima di passare al blocco successivo. (Ripetere per ogni blocco; dopo il mio ok, risalva con approved: true.)`);
  add(path === 'stesura' ? 'B8' : 'A7', 'Assemblaggio + seam review', 'testo unificato e saldature invisibili',
    `Assembla la revisione completa con novel_assemble_chapter_revision (sessionId <sessionId>, expectedBlocks <numero blocchi>). Se mancano blocchi, fermati ed elencameli. Poi rileggi il testo unificato e fai la seam review: transizioni tra blocchi, ripetizioni introdotte dalle riscritture, coerenza interna di tono e ritmo. Poi ANALISI DIFFERENZIALE sull'intero romanzo: con kg_semantic_search confronta descrizioni, immagini ricorrenti e tic linguistici del testo unificato contro i capitoli già canonizzati (sono embeddati nel grafo) e segnala ridondanze o incoerenze immediate col finale del capitolo precedente. Salva l'esito con novel_save_seam_review (summary, findings, approved solo dopo il mio ok).${numbered ? ` Quando approvo il testo: rileggi SEMPRE la bozza corrente con novel_get_working_draft (sessionId <sessionId>, chapterNumber: ${chapter!.number}); se nel frattempo l'hash o la revisione sono cambiati, recepisci quella versione e riapplica soltanto le modifiche approvate. Aggiorna quindi il nodo corrente con novel_update_working_draft usando expectedContentHash ed expectedRevision appena letti. Se ricevi DRAFT_VERSION_CONFLICT, fermati e riportamelo: non forzare e non fare merge automatici.` : ''} Presentami il testo finale completo per lettura.`);
  if (path === 'revisione') {
    add('A8', 'Scan impatto (se cambi fatti canonici)', 'solo se la revisione modifica canone già registrato',
      `La revisione modifica questi fatti già canonici: <elenco: nodo/etichetta → vecchio contenuto → nuovo contenuto>. Esegui novel_scan_revision_impact (${ident}, changedFacts) e riportami i nodi impattati, i conflitti di polarità e gli shift semantici. NON propagare nessuna modifica a cascata: presentami solo il report e le azioni proposte, decido io quali applicare. (Salta questo prompt se la revisione non tocca fatti canonici.)`);
  }
  add(path === 'stesura' ? 'B9' : 'A9*', 'Visual brief (opzionale)', 'PRIMA della canonizzazione: chiude la sessione',
    `Prepara il visual brief della scena chiave di ${phrase} con novel_create_visual_brief sulla sessione ancora aperta (da eseguire PRIMA della canonizzazione, che elimina il file di sessione): sceneSummary, characters, promptIt e promptEn coerenti con l'aspetto canonico dei personaggi al momento della scena (character_state datati). Nota: l'attach dell'immagine da filesystem è disabilitato in questo progetto; il brief resta nel file di sessione.`);
  add(path === 'stesura' ? 'B10' : 'A10', 'Canonizzazione', 'unico passaggio che trasforma la bozza in canone',
    `Canonizza ${phrase}: ${numbered ? `verifica prima con novel_get_working_draft che il nodo di bozza contenga esattamente il testo finale approvato; se non coincide, aggiornalo con novel_update_working_draft mediante CAS e non procedere in caso di conflitto. Poi ` : ''}chiama novel_save_final_chapter con sessionId <sessionId>, ${ident}${titleArg}, status "approved" e il testo finale assemblato e approvato. Confermami che il nodo chapter è stato aggiornato in place (canonStatus canonical, finalHash valorizzato), che il file di sessione e tutte le revisioni sono stati eliminati e che non restano chapter_draft/document/chunk temporanei della sezione.`);
  add(path === 'stesura' ? 'B11' : 'A11', 'Estrazione e commit dei fatti', 'la prosa finale diventa nodi/archi canonici',
    `Estrai i fatti narrativi dal testo finale di ${phrase} con novel_extract_chapter_candidates (${ident}, content: <testo finale>). Poi valida i candidati con novel_chapter_validation_packet e mostrami: candidati estratti, errori di validazione, discrepanze verso il canone esistente (lessicali e semantiche) con la loro severità. Proponimi la lista finale da committare distinguendo nuovi nodi, nuovi archi e candidati da scartare perché duplicati di canone esistente. Attendi il mio ok, poi esegui novel_commit_chapter_candidates solo sui candidati approvati.`);
  add(path === 'stesura' ? 'B12' : 'A12', 'Post-write e chiusura', 'verifica integrità e aggiorna la memoria della mente',
    `Chiudi il ciclo: esegui novel_chapter_postwrite_status (${ident}, nodeIds: <id committati>), kg_backfill_embeddings (missingOnly: true), kg_audit_global e novel_bible_coverage_report. Riportami: che tutti i nodi committati esistono, sono canonici e collegati; che non ci sono nodi senza embedding; che l'audit non segnala regressioni. Se questo lavoro risponde a una domanda aperta della mente (kg_list_open_questions), chiudila con kg_update_open_question (resolved, con motivazione). Riepilogami cosa è entrato nel canone con questo ciclo.`);
  return steps;
}

function EditorialePanel({
  drafts,
  characters,
  chapters,
  onOpen,
  onRefreshDrafts,
  draftEditorDirty,
  onDraftEditorDirtyChange,
}: {
  drafts: KgNode[];
  characters: KgNode[];
  chapters: ChapterSummary[];
  onOpen: (id: string, type: string) => void;
  onRefreshDrafts: () => void;
  draftEditorDirty: boolean;
  onDraftEditorDirtyChange: (dirty: boolean) => void;
}) {
  const [persona, setPersona] = useState('');
  const [persona2, setPersona2] = useState('');
  const [promptChapter, setPromptChapter] = useState('');
  const [momento, setMomento] = useState('');
  const [scena, setScena] = useState('');
  const [elemento, setElemento] = useState('');
  const [section, setSection] = useState('');
  const [editorialPath, setEditorialPath] = useState<EditorialPath>('revisione');
  const [copied, setCopied] = useState<string | null>(null);
  // Valori di sessione del workflow guidato: compilati una volta qui, vengono autocompilati
  // in ogni prompt A/B al posto dei token <sessionId>/<numeroBlocco>/<numero blocchi>/<id committati>.
  const [wfSessionId, setWfSessionId] = useState('');
  const [wfBlocco, setWfBlocco] = useState('');
  const [wfBlocchiTotali, setWfBlocchiTotali] = useState('');
  const [wfNodeIds, setWfNodeIds] = useState('');
  const selSection = chapters.find((chapter) => chapter.id === section) ?? null;
  const sectionPhrase = (chapter: ChapterSummary): string =>
    chapter.role === 'prologo' ? 'il Prologo' : chapter.role === 'epilogo' ? "l'Epilogo" : `il Capitolo ${chapter.number} «${chapter.title}»`;
  const sectionTag = (chapter: ChapterSummary): string =>
    chapter.role === 'prologo' ? 'Prologo' : chapter.role === 'epilogo' ? 'Epilogo' : `Cap ${chapter.number}`;
  const charGroups = useMemo(() => {
    const map = new Map<string, KgNode[]>();
    for (const node of characters) {
      const key = characterCategory(node);
      const list = map.get(key) ?? [];
      list.push(node);
      map.set(key, list);
    }
    return CHARACTER_CATEGORY_ORDER.filter((key) => map.has(key)).map((key) => ({ key, items: map.get(key)!.slice().sort((a, b) => a.label.localeCompare(b.label)) }));
  }, [characters]);
  const promptChap = chapters.find((chapter) => chapter.id === promptChapter) ?? null;
  // Un solo motore di sostituzione segnaposto, condiviso da entrambi i pannelli (pipeline a fasi
  // e prompt preimpostati): un valore compilato in un pannello risolve lo stesso token ovunque
  // compaia. `overrides` permette a copyStep di imporre {SEZIONE}/{N} dalla sezione scelta.
  const placeholderValues = (): Record<string, string | undefined> => ({
    PERSONAGGIO: persona || undefined,
    ALTRO_PERSONAGGIO: persona2 || undefined,
    CAPITOLO: promptChap ? sectionPhrase(promptChap) : undefined,
    MOMENTO: momento.trim() || undefined,
    SCENA: scena.trim() || undefined,
    ELEMENTO: elemento.trim() || undefined,
    N: promptChap ? String(promptChap.number ?? promptChap.role ?? '') : undefined,
  });
  const substitute = (body: string, overrides: Record<string, string | undefined> = {}): string => {
    const values = { ...placeholderValues(), ...overrides };
    let text = body;
    for (const [token, value] of Object.entries(values)) {
      if (value !== undefined) text = text.replaceAll(`{${token}}`, value);
    }
    return text;
  };
  const fillPrompt = (body: string): string => substitute(body);
  const copyStep = (id: string, body: string, perSection: boolean): void => {
    let text: string;
    if (perSection && selSection) {
      const phrase = sectionPhrase(selSection);
      text = substitute(body, { SEZIONE: phrase, N: String(selSection.number ?? selSection.role ?? '') })
        + `\n\n[Sezione mirata: ${phrase} — nodo capitolo id ${selSection.id}. Carica prima il suo context packet dal modello neurale e lavora SOLO su questa sezione.]`;
    } else {
      text = substitute(body, { SEZIONE: 'la sezione (capitolo/prologo/epilogo)' });
      if (text.includes('{N}')) text = text.replaceAll('{N}', 'N');
    }
    void navigator.clipboard?.writeText(text);
    setCopied(id);
  };
  const charOptions = () => charGroups.map((group) => (
    <optgroup key={group.key} label={group.key}>
      {group.items.map((node) => <option key={node.id} value={node.label}>{node.label}</option>)}
    </optgroup>
  ));
  const copyPrompt = (id: string, body: string): void => {
    void navigator.clipboard?.writeText(fillPrompt(body));
    setCopied(id);
  };
  const visibleSteps = EDITORIAL_STEPS.filter((step) => step.paths.includes(editorialPath));
  const workflowSteps = useMemo(() => buildWorkflowPrompts(editorialPath, selSection), [editorialPath, selSection]);
  const wfSubstitute = (body: string): string => {
    let text = body;
    if (wfSessionId.trim()) text = text.replaceAll('<sessionId>', wfSessionId.trim());
    if (wfBlocco.trim()) text = text.replaceAll('<numeroBlocco>', wfBlocco.trim());
    if (wfBlocchiTotali.trim()) text = text.replaceAll('<numero blocchi>', wfBlocchiTotali.trim());
    if (wfNodeIds.trim()) text = text.replaceAll('<id committati>', wfNodeIds.trim());
    return text;
  };
  const copyWorkflow = (id: string, body: string): void => {
    void navigator.clipboard?.writeText(wfSubstitute(body));
    setCopied(id);
  };
  const changeSection = (nextSection: string): void => {
    if (draftEditorDirty && nextSection !== section) {
      const discard = window.confirm('La bozza contiene modifiche non salvate. Cambiare capitolo e perderle?');
      if (!discard) return;
    }
    setSection(nextSection);
  };
  return (
    <div className="novel-panel">
      <div className="novel-head">
        <h2>Cockpit Editoriale</h2>
        <p className="novel-sub">
          Prompt pronti da incollare in chat con il modello collegato al grafo via <span className="edge-kind">MCP</span>: sfruttano il modello neurale in stesura e revisione. La valutazione qualitativa della prosa avviene in chat sul canone (ground truth); la pipeline <span className="edge-kind">novel_*</span> persiste bozze e decisioni. L’editor sottostante modifica soltanto la bozza della sessione, mai il canone.
        </p>
      </div>

      <section className="novel-block">
        <h3>Pipeline editoriale — 8 fasi core (0-7)</h3>
        <p className="novel-note">Rispetto al vecchio flusso (che rileggeva l'intera Bibbia come file), qui ogni fase interroga il modello neurale via <span className="edge-kind">MCP</span> per il canone esatto. Copia il prompt generico (in attesa del testo) o quello pre-ottimizzato per una sezione specifica.</p>
        <div className="persona-pick path-pick">
          <label>Percorso</label>
          <div className="path-toggle">
            <button type="button" className={editorialPath === 'revisione' ? 'active' : ''} onClick={() => setEditorialPath('revisione')}>Revisione di un capitolo già scritto</button>
            <button type="button" className={editorialPath === 'stesura' ? 'active' : ''} onClick={() => setEditorialPath('stesura')}>Stesura diretta dai punti della Bibbia</button>
          </div>
          <span className="persona-hint">
            {editorialPath === 'revisione'
              ? 'Parti da un testo esistente: aggiunge la Fase 4.5 (scansione impatto) prima di chiudere una modifica a un fatto già canonico.'
              : 'Nessun testo esistente: aggiunge la Fase 0.5 (prima bozza scritta solo dal context packet della Bibbia/grafo).'}
          </span>
        </div>
        <div className="persona-pick">
          <label>Sezione da lavorare (pre-ottimizza i prompt)</label>
          <select value={section} onChange={(event) => changeSection(event.target.value)}>
            <option value="">— generico (nessuna sezione) —</option>
            {chapters.map((chapter) => (
              <option key={chapter.id} value={chapter.id}>{chapter.role === 'prologo' ? 'Prologo' : chapter.role === 'epilogo' ? 'Epilogo' : `Cap ${chapter.number} — ${chapter.title}`}</option>
            ))}
          </select>
          <span className="persona-hint">{selSection ? `Prompt pre-ottimizzati per ${sectionTag(selSection)}.` : 'Scegli una sezione per pre-ottimizzare i prompt, oppure copia la versione generica.'}</span>
        </div>
        <div className="step-list">
          {visibleSteps.map((step) => (
            <div className="step-card" key={step.id}>
              <div className="step-h">
                <span className="step-n">{step.n}</span>
                <div className="step-ti"><b>{step.title}</b><small>{step.role}</small></div>
              </div>
              <p className="step-neural">{step.neural}</p>
              <div className="step-actions">
                <button className="prompt-copy" onClick={() => copyStep(`${step.id}-g`, step.body, false)}>{copied === `${step.id}-g` ? <><Check size={13} />copiato</> : <><Copy size={13} />prompt generico</>}</button>
                <button className="prompt-copy sect" disabled={!selSection} onClick={() => copyStep(`${step.id}-s`, step.body, true)}>{copied === `${step.id}-s` ? <><Check size={13} />copiato</> : <><Copy size={13} />{selSection ? `per ${sectionTag(selSection)}` : 'per sezione'}</>}</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="novel-block">
        <h3>Workflow guidato — sessione MCP passo-passo <small>{editorialPath === 'revisione' ? 'Processo A' : 'Processo B'}{selSection ? ` · ${sectionTag(selSection)}` : ''}</small></h3>
        <p className="novel-note">
          Prompt <b>autogenerati sulla sezione scelta sopra</b> (Prologo/Epilogo usano <code>role</code>, i capitoli numerati <code>chapterNumber</code>) e sul percorso selezionato. Vanno lanciati <b>in ordine, uno per turno, in un'unica chat dedicata alla sezione</b>; i token fra parentesi angolari (es. <code>&lt;sessionId&gt;</code>, <code>&lt;N&gt;</code>) si compilano durante la chat con i valori restituiti dai tool. Lo stato editoriale è persistito dal server in un file di sessione: se la chat si interrompe, in una chat nuova basta rilanciare <code>novel_start_editing_session</code> con lo stesso <code>sessionId</code> e riprendere dal prompt dove eri rimasto. I processi schedulati della mente (P0–P4) girano invece ciascuno in una chat propria.
        </p>
        <div className="persona-pick">
          <label>Valori di sessione (autocompilati nei prompt qui sotto)</label>
          <div className="prompt-fields">
            <div className="pf">
              <label>Session ID <code>{'<sessionId>'}</code></label>
              <input
                value={wfSessionId}
                disabled={draftEditorDirty}
                onChange={(event) => setWfSessionId(event.target.value)}
                placeholder="es. editing-002-a1b2c3d4e5f6"
                title={draftEditorDirty ? 'Salva o ricarica la bozza prima di cambiare sessione.' : undefined}
              />
            </div>
            <div className="pf">
              <label>Blocco corrente <code>{'<numeroBlocco>'}</code></label>
              <input value={wfBlocco} onChange={(event) => setWfBlocco(event.target.value)} placeholder="es. 1" />
            </div>
            <div className="pf">
              <label>Totale blocchi <code>{'<numero blocchi>'}</code></label>
              <input value={wfBlocchiTotali} onChange={(event) => setWfBlocchiTotali(event.target.value)} placeholder="es. 2" />
            </div>
            <div className="pf wide">
              <label>ID nodi committati <code>{'<id committati>'}</code></label>
              <input value={wfNodeIds} onChange={(event) => setWfNodeIds(event.target.value)} placeholder="es. abc-123, def-456 (dal commit dei candidati)" />
            </div>
          </div>
          <span className="persona-hint">Compila i valori man mano che i tool te li restituiscono (il sessionId da novel_start_editing_session, i blocchi dallo split, gli id dal commit): i prompt successivi si aggiornano da soli. I campi vuoti restano come token <code>{'<…>'}</code> da completare in chat.</span>
        </div>
        <div className="step-list">
          {workflowSteps.map((step) => (
            <div className="step-card" key={step.code}>
              <div className="step-h">
                <span className="step-n">{step.code}</span>
                <div className="step-ti"><b>{step.title}</b><small>{step.hint}</small></div>
              </div>
              <p className="prompt-body">{wfSubstitute(step.body)}</p>
              <div className="step-actions">
                <button className="prompt-copy" onClick={() => copyWorkflow(`wf-${step.code}`, step.body)}>
                  {copied === `wf-${step.code}` ? <><Check size={13} />copiato</> : <><Copy size={13} />copia prompt</>}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="novel-block draft-workspace">
        <h3>Editor della bozza <small>salvataggio concorrente protetto</small></h3>
        <p className="novel-note">
          Disponibile per i capitoli numerati e per una sessione editoriale identificata. Il salvataggio usa hash e revisione: se il server contiene una versione più recente, il testo locale viene conservato finché non scegli esplicitamente come procedere.
        </p>
        <ChapterDraftEditor
          key={`${selSection?.id ?? 'nessuna-sezione'}:${wfSessionId.trim()}`}
          chapter={selSection}
          sessionId={wfSessionId}
          onDirtyChange={onDraftEditorDirtyChange}
          onSaved={onRefreshDrafts}
        />
      </section>

      <section className="novel-block">
        <h3>Prompt preimpostati</h3>
        <div className="persona-pick">
          <label>Compila i segnaposto (sostituiti alla copia)</label>
          <div className="prompt-fields">
            <div className="pf">
              <label>Personaggio <code>{'{PERSONAGGIO}'}</code></label>
              <select value={persona} onChange={(event) => setPersona(event.target.value)}>
                <option value="">— segnaposto —</option>
                {charOptions()}
              </select>
            </div>
            <div className="pf">
              <label>Altro personaggio <code>{'{ALTRO_PERSONAGGIO}'}</code></label>
              <select value={persona2} onChange={(event) => setPersona2(event.target.value)}>
                <option value="">— segnaposto —</option>
                {charOptions()}
              </select>
            </div>
            <div className="pf">
              <label>Capitolo <code>{'{CAPITOLO}'}</code> · <code>{'{N}'}</code></label>
              <select value={promptChapter} onChange={(event) => setPromptChapter(event.target.value)}>
                <option value="">— segnaposto —</option>
                {chapters.map((chapter) => (
                  <option key={chapter.id} value={chapter.id}>{chapter.role === 'prologo' ? 'Prologo' : chapter.role === 'epilogo' ? 'Epilogo' : `Cap ${chapter.number} — ${chapter.title}`}</option>
                ))}
              </select>
            </div>
            <div className="pf">
              <label>Momento <code>{'{MOMENTO}'}</code></label>
              <input value={momento} onChange={(event) => setMomento(event.target.value)} placeholder={'es. "Cap. 17" o "05/10/2020"'} />
            </div>
            <div className="pf wide">
              <label>Scena <code>{'{SCENA}'}</code></label>
              <input value={scena} onChange={(event) => setScena(event.target.value)} placeholder="breve descrizione della scena / del contesto" />
            </div>
            <div className="pf wide">
              <label>Elemento <code>{'{ELEMENTO}'}</code></label>
              <input value={elemento} onChange={(event) => setElemento(event.target.value)} placeholder={'oggetto/elemento da verificare, es. "il ciondolo del Nonno"'} />
            </div>
          </div>
          <span className="persona-hint">Impersonabile ogni personaggio (protagonisti, principali, forze sovrannaturali, secondari, cornice). I campi vuoti restano come <code>{'{…}'}</code> nel prompt copiato, così sai cosa completare a mano.</span>
        </div>
        {PROMPT_GROUPS.map((section) => (
          <div className="prompt-section" key={section.group}>
            <div className="prompt-section-h">{section.group}</div>
            <div className="prompt-grid">
              {section.prompts.map((prompt) => (
                <div className="prompt-card" key={prompt.id}>
                  <div className="prompt-card-h">
                    <b>{prompt.title}</b>
                    <button className="prompt-copy" onClick={() => copyPrompt(prompt.id, prompt.body)} title="Copia negli appunti">
                      {copied === prompt.id ? <><Check size={13} />copiato</> : <><Copy size={13} />copia</>}
                    </button>
                  </div>
                  <p className="prompt-body">{fillPrompt(prompt.body)}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="novel-block">
        <h3>Bozze di capitolo nel grafo <small>{drafts.length}</small></h3>
        <p className="novel-note">Le sessioni editoriali sono conservate nel volume filesystem e si riaprono tramite il loro <code>sessionId</code>; non sono nodi del grafo e quindi non vengono elencate qui.</p>
        {drafts.length === 0 ? (
          <p className="muted">Nessuna bozza di capitolo presente nel grafo.</p>
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
        <p className="novel-note">La ridondanza semantica cross-capitolo richiede embeddings attivi (attualmente disabilitati, nessun modello locale). Gli altri quattro assi sono ancorati alla Bibbia consolidata e già pienamente operativi.</p>
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

    // View transform (world -> screen): sx = x * scale + ox. Auto-fits the graph to the canvas.
    let scale = 1;
    let ox = 0;
    let oy = 0;
    const PAD = 34;
    const fit = (): void => { W = cv.clientWidth || host.clientWidth || 600; cv.width = W * dpr; cv.height = H * dpr; };
    const seed = (): void => { fit(); const cx = W / 2; const cy = H / 2; const R = Math.min(W, H) / 2 - 42; N.forEach((n, i) => { const a = (i / N.length) * Math.PI * 2; n.x = cx + Math.cos(a) * R * 0.7; n.y = cy + Math.sin(a) * R * 0.7; }); seeded = true; };
    const vis = (n: N): boolean => !offT[n.type];
    const visE = (e: { s: N; d: N; k: string }): boolean => !offK[e.k] && vis(e.s) && vis(e.d);
    const neighbor = (a: N, b: N): boolean => E.some((e) => visE(e) && ((e.s === a && e.d === b) || (e.d === a && e.s === b)));
    const SX = (x: number): number => x * scale + ox;
    const SY = (y: number): number => y * scale + oy;
    // Target transform that centers all visible nodes and fits them into the canvas with padding.
    const targetFit = (): { s: number; x: number; y: number } => {
      const vs = N.filter(vis);
      if (!vs.length) return { s: 1, x: 0, y: 0 };
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      for (const n of vs) { const r = nodeRadius(n.type) + 18; if (n.x - r < minX) minX = n.x - r; if (n.x + r > maxX) maxX = n.x + r; if (n.y - r < minY) minY = n.y - r; if (n.y + r > maxY) maxY = n.y + r; }
      const bw = Math.max(1, maxX - minX); const bh = Math.max(1, maxY - minY);
      const s = Math.min((W - PAD * 2) / bw, (H - PAD * 2) / bh, 1.7);
      return { s, x: W / 2 - ((minX + maxX) / 2) * s, y: H / 2 - ((minY + maxY) / 2) * s };
    };
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
        fx += (W / 2 - a.x) * 0.01;
        fy += (H / 2 - a.y) * 0.01;
        a.fx = fx;
        a.fy = fy;
      }
      E.forEach((e) => { if (!visE(e)) return; const dx = e.d.x - e.s.x; const dy = e.d.y - e.s.y; const d = Math.sqrt(dx * dx + dy * dy) || 0.01; const f = (d - 98) * 0.015; const ux = dx / d; const uy = dy / d; e.s.fx += ux * f; e.s.fy += uy * f; e.d.fx -= ux * f; e.d.fy -= uy * f; });
      vs.forEach((n) => { if (n === drag) return; n.vx = (n.vx + n.fx * alpha) * 0.86; n.vy = (n.vy + n.fy * alpha) * 0.86; n.x += n.vx; n.y += n.vy; if (!Number.isFinite(n.x)) n.x = W / 2; if (!Number.isFinite(n.y)) n.y = H / 2; });
      alpha *= 0.975;
    };
    const draw = (): void => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      E.forEach((e) => { if (!visE(e)) return; const hl = !!hover && (e.s === hover || e.d === hover); ctx.strokeStyle = ekColor(e.k); ctx.globalAlpha = hover ? (hl ? 0.95 : 0.1) : 0.5; ctx.lineWidth = hl ? 2 : 1; ctx.beginPath(); ctx.moveTo(SX(e.s.x), SY(e.s.y)); ctx.lineTo(SX(e.d.x), SY(e.d.y)); ctx.stroke(); });
      ctx.globalAlpha = 1;
      if (hover) { ctx.textAlign = 'center'; ctx.font = `10px ${MONO_F}`; E.forEach((e) => { if (!visE(e) || (e.s !== hover && e.d !== hover)) return; ctx.fillStyle = ekColor(e.k); ctx.fillText(e.k, (SX(e.s.x) + SX(e.d.x)) / 2, (SY(e.s.y) + SY(e.d.y)) / 2 - 3); }); }
      N.forEach((n) => {
        if (!vis(n)) return;
        const r = nodeRadius(n.type);
        const x = SX(n.x);
        const y = SY(n.y);
        const dim = !!hover && hover !== n && !neighbor(hover, n);
        ctx.globalAlpha = dim ? 0.26 : 1;
        if (n.frame) { ctx.beginPath(); ctx.arc(x, y, r + 3, 0, 7); ctx.strokeStyle = '#9b8ce6'; ctx.lineWidth = 1.5; ctx.stroke(); }
        ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = colorFor(n.type); ctx.fill();
        if (n === hover || n === drag) { ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke(); }
        ctx.font = `11px ${SANS_F}`; ctx.fillStyle = '#eaecf2'; ctx.textAlign = 'center';
        const lbl = n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label;
        ctx.fillText(lbl, x, y + r + 11);
      });
      ctx.globalAlpha = 1;
    };
    const loop = (): void => {
      tick();
      const t = targetFit();
      const conv = Math.abs(t.s - scale) < 0.003 && Math.abs(t.x - ox) < 0.6 && Math.abs(t.y - oy) < 0.6;
      scale += (t.s - scale) * 0.14;
      ox += (t.x - ox) * 0.14;
      oy += (t.y - oy) * 0.14;
      draw();
      if (alpha > 0.02 || !conv) raf = requestAnimationFrame(loop); else raf = null;
    };
    function reheat(a: number): void { if (!seeded) seed(); else fit(); alpha = Math.max(alpha, a); if (!raf) raf = requestAnimationFrame(loop); }
    const pos = (ev: MouseEvent): { x: number; y: number } => { const r = cv.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
    const pick = (p: { x: number; y: number }): N | null => { let best: N | null = null; let bd = 1e9; N.forEach((n) => { if (!vis(n)) return; const dx = SX(n.x) - p.x; const dy = SY(n.y) - p.y; const d = dx * dx + dy * dy; const rr = nodeRadius(n.type) + 6; if (d < rr * rr && d < bd) { bd = d; best = n; } }); return best; };
    let moved = false;
    const onMove = (ev: MouseEvent): void => {
      const p = pos(ev);
      if (drag) { drag.x = (p.x - ox) / scale; drag.y = (p.y - oy) / scale; drag.vx = 0; drag.vy = 0; moved = true; reheat(0.4); }
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
  const [tab, setTab] = useState<Tab>('romanzo');
  const [editorDraftDirty, setEditorDraftDirty] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ Panoramica: true, 'Entità': false, Lavoro: false });
  const toggleGroup = useCallback((group: string) => setOpenGroups((state) => ({ ...state, [group]: !state[group] })), []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminMessage, setAdminMessage] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>('upsert');
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [snapshotFileName, setSnapshotFileName] = useState('');
  const [importResult, setImportResult] = useState<SnapshotImportResult | null>(null);
  const [serverProjectId, setServerProjectId] = useState<string | null>(null);
  const [chapters, setChapters] = useState<ChapterSummary[]>([]);
  const [chapterPacket, setChapterPacket] = useState<ChapterPacket | null>(null);
  const [characters, setCharacters] = useState<KgNode[]>([]);
  const [arcs, setArcs] = useState<KgNode[]>([]);
  const [world, setWorld] = useState<KgNode[]>([]);
  const [themes, setThemes] = useState<KgNode[]>([]);
  const [styleGuide, setStyleGuide] = useState<KgNode[]>([]);
  const [entityPacket, setEntityPacket] = useState<EntityPacket | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [drafts, setDrafts] = useState<KgNode[]>([]);
  const graphRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods<NodeObject<GNode>, LinkObject<GNode, GLink>> | undefined>(undefined);
  const [dims, setDims] = useState({ width: 900, height: 640 });

  const selectedOpenPoint = useMemo(
    () => openPoints.find((point) => point.finding.id === selectedOpenPointId) ?? null,
    [openPoints, selectedOpenPointId],
  );

  const changeTab = useCallback((nextTab: Tab): boolean => {
    if (nextTab === tab) return true;
    if (tab === 'editoriale' && editorDraftDirty) {
      const discard = window.confirm('La bozza contiene modifiche non salvate. Uscire dall’area editoriale e perderle?');
      if (!discard) return false;
      setEditorDraftDirty(false);
    }
    setTab(nextTab);
    return true;
  }, [editorDraftDirty, tab]);

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
    if (!changeTab('capitolo')) return;
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
  }, [changeTab]);

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
      const parts = await Promise.all(WORLD_TYPES.map((type) => listKgNodes(200, type)));
      setWorld(parts.flatMap((part) => part.nodes));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [world.length]);

  const loadThemes = useCallback(async () => {
    if (themes.length) return;
    setLoading(true);
    setError(null);
    try {
      const parts = await Promise.all(THEME_TYPES.map((type) => listKgNodes(200, type)));
      setThemes(parts.flatMap((part) => part.nodes));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [themes.length]);

  const loadStyle = useCallback(async () => {
    if (styleGuide.length) return;
    setLoading(true);
    setError(null);
    try {
      const parts = await Promise.all(STYLE_TYPES.map((type) => listKgNodes(200, type)));
      setStyleGuide(parts.flatMap((part) => part.nodes));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [styleGuide.length]);

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
    setLoading(true);
    setError(null);
    try {
      setDrafts((await listKgNodes(100, 'chapter_draft')).nodes);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const openEntity = useCallback(async (id: string, type: string) => {
    // Chapters keep their dedicated packet view; everything else uses the entity packet.
    if (type === 'chapter') {
      void openChapter(id);
      return;
    }
    const targetTab = ENTITY_TAB[type] ?? (KEEP_TAB.has(tab) ? tab : 'personaggio');
    if (!changeTab(targetTab)) return;
    setSelectedId(id);
    setLoading(true);
    setError(null);
    try {
      setEntityPacket(await getEntityPacket(id));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [changeTab, openChapter, tab]);

  useEffect(() => {
    void refreshStats().catch((err) => setError(String(err)));
  }, [refreshStats]);

  // Server projectId, used as confirmProjectId for a replaceProject import without a prior dry-run.
  useEffect(() => {
    void getConfig().then((cfg) => setServerProjectId(cfg.projectId)).catch(() => undefined);
  }, []);

  useEffect(() => {
    void loadNodes().catch((err) => setError(String(err)));
  }, [loadNodes]);

  // Default view is Romanzo: load the chapter list on mount.
  useEffect(() => {
    void loadChapters().catch((err) => setError(String(err)));
  }, [loadChapters]);

  useEffect(() => {
    const element = graphRef.current;
    if (!element) return;
    const update = (): void => setDims({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Keep the active tab's nav group open.
  useEffect(() => {
    setOpenGroups((state) => (state[TAB_GROUP[tab]] ? state : { ...state, [TAB_GROUP[tab]]: true }));
  }, [tab]);

  // Re-center + fit the main force graph when its container resizes or the tab is shown.
  useEffect(() => {
    if (tab === 'search') {
      const timer = setTimeout(() => fgRef.current?.zoomToFit(300, 48), 60);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [dims.width, dims.height, tab, graph]);

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
    if (!snapshot) return;
    if (importMode === 'replaceProject' && !window.confirm('Confermi la sostituzione completa del progetto corrente?')) return;
    setAdminBusy(true);
    setError(null);
    setAdminMessage(null);
    try {
      // The commit re-validates server-side, so a prior dry-run is optional. For replaceProject
      // the server requires confirmProjectId === its own projectId; use the dry-run's value if
      // present, otherwise the projectId fetched from /api/config.
      const confirmProjectId = importResult?.report.targetProjectId ?? serverProjectId ?? undefined;
      const result = await commitGraphSnapshotImport(snapshot, importMode, confirmProjectId);
      setImportResult(result);
      setAdminMessage(result.ok ? `Import completato: ${result.written?.nodes ?? 0} nodi, ${result.written?.edges ?? 0} archi` : 'Import respinto');
      if (result.ok) {
        changeTab('search');
        void refreshStats();
        void loadNodes();
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setAdminBusy(false);
    }
  }, [changeTab, importMode, importResult, loadNodes, refreshStats, snapshot, serverProjectId]);

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
          <div className="sidebar-nav">
          <NavGroup label="Panoramica" open={openGroups['Panoramica']} onToggle={() => toggleGroup('Panoramica')} />
          {openGroups['Panoramica'] && (
          <div className="tabs" role="tablist">
            <button className={tab === 'romanzo' ? 'active' : ''} onClick={() => { if (changeTab('romanzo')) void loadChapters(); }}><BookOpen size={15} />Romanzo</button>
            <button className={tab === 'timeline' ? 'active' : ''} onClick={() => { if (changeTab('timeline')) void loadTimeline(); }}><Clock size={15} />Timeline</button>
            <button className={tab === 'coerenza' ? 'active' : ''} onClick={() => { if (changeTab('coerenza')) void loadHealth(); }}><Activity size={15} />Coerenza</button>
          </div>
          )}
          <NavGroup label="Entità" open={openGroups['Entità']} onToggle={() => toggleGroup('Entità')} />
          {openGroups['Entità'] && (
          <div className="tabs" role="tablist">
            <button className={tab === 'capitolo' ? 'active' : ''} onClick={() => { if (changeTab('capitolo')) void loadChapters(); }}><ScrollText size={15} />Capitolo</button>
            <button className={tab === 'personaggio' ? 'active' : ''} onClick={() => { if (changeTab('personaggio')) void loadCharacters(); }}><Users size={15} />Personaggi</button>
            <button className={tab === 'arco' ? 'active' : ''} onClick={() => { if (changeTab('arco')) void loadArcs(); }}><GitBranch size={15} />Archi</button>
            <button className={tab === 'mondo' ? 'active' : ''} onClick={() => { if (changeTab('mondo')) void loadWorld(); }}><Globe2 size={15} />Mondo</button>
            <button className={tab === 'temi' ? 'active' : ''} onClick={() => { if (changeTab('temi')) void loadThemes(); }}><Sparkles size={15} />Temi</button>
            <button className={tab === 'stile' ? 'active' : ''} onClick={() => { if (changeTab('stile')) void loadStyle(); }}><Feather size={15} />Stile &amp; Regole</button>
          </div>
          )}
          <NavGroup label="Lavoro" open={openGroups['Lavoro']} onToggle={() => toggleGroup('Lavoro')} />
          {openGroups['Lavoro'] && (
          <div className="tabs" role="tablist">
            <button className={tab === 'editoriale' ? 'active' : ''} onClick={() => { if (changeTab('editoriale')) { void loadDrafts(); void loadCharacters(); void loadChapters(); } }}><PenLine size={15} />Editoriale</button>
            <button className={tab === 'search' ? 'active' : ''} onClick={() => changeTab('search')}><Search size={15} />Grafo</button>
            <button className={tab === 'openPoints' ? 'active' : ''} onClick={() => { if (changeTab('openPoints')) void loadOpenPoints(); }}><ListChecks size={15} />Punti aperti</button>
            <button className={tab === 'documents' ? 'active' : ''} onClick={() => { if (changeTab('documents')) void loadDocuments(); }}><FileText size={15} />Documenti</button>
            <button className={tab === 'admin' ? 'active' : ''} onClick={() => changeTab('admin')}><ShieldCheck size={15} />Admin</button>
          </div>
          )}

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
                Verifica (dry-run, opzionale)
              </button>
              <button className="command-button danger" onClick={() => void runImportCommit()} disabled={adminBusy || !snapshot}>
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
          </div>

          <div className="sidebar-scroll">
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
            <GroupedNavList nodes={characters} groupOf={characterCategory} order={CHARACTER_CATEGORY_ORDER} selectedId={selectedId} onOpen={(node) => void openEntity(node.id, 'character')} />
          ) : tab === 'arco' ? (
            <EntityNavList nodes={arcs} selectedId={selectedId} onOpen={(id) => void openEntity(id, 'plot_thread')} />
          ) : tab === 'mondo' ? (
            <GroupedNavList nodes={world} groupOf={(node) => labelFor(node.type)} order={WORLD_TYPES.map(labelFor)} selectedId={selectedId} onOpen={(node) => void openEntity(node.id, node.type)} />
          ) : tab === 'temi' ? (
            <GroupedNavList nodes={themes} groupOf={themeGroup} order={['Livello 1 — Temi architettonici', 'Livello 2 — Temi evolutivi', 'Livello 3 — Temi relazionali', 'Livello 4 — Temi esistenziali', 'Motivi ricorrenti', 'Altri temi']} selectedId={selectedId} onOpen={(node) => void openEntity(node.id, node.type)} />
          ) : tab === 'stile' ? (
            <GroupedNavList nodes={styleGuide} groupOf={(node) => labelFor(node.type)} order={STYLE_TYPES.map(labelFor)} selectedId={selectedId} onOpen={(node) => void openEntity(node.id, node.type)} />
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
          </div>
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
          ) : tab === 'personaggio' || tab === 'arco' || tab === 'mondo' || tab === 'temi' || tab === 'stile' ? (
            <EntityPanel packet={entityPacket} onOpen={(id, type) => void openEntity(id, type)} />
          ) : tab === 'timeline' ? (
            <TimelinePanel entries={timeline} onOpenChapter={(id) => void openChapter(id)} onOpenEntity={(id) => void openEntity(id, 'timeline_event')} />
          ) : tab === 'coerenza' ? (
            <CoerenzaPanel health={health} onOpenPoints={() => { if (changeTab('openPoints')) void loadOpenPoints(); }} />
          ) : tab === 'editoriale' ? (
            <EditorialePanel
              drafts={drafts}
              characters={characters}
              chapters={chapters}
              onOpen={(id, type) => void openEntity(id, type)}
              onRefreshDrafts={() => { void loadDrafts(); void refreshStats(); }}
              draftEditorDirty={editorDraftDirty}
              onDraftEditorDirtyChange={setEditorDraftDirty}
            />
          ) : graph.nodes.length > 0 ? (
            <ForceGraph2D<GNode, GLink>
              ref={fgRef}
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
              cooldownTicks={120}
              onEngineStop={() => fgRef.current?.zoomToFit(400, 48)}
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
