import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { Activity, BookOpen, Check, Clock, Copy, Database, Download, Feather, FileText, GitBranch, Globe2, ListChecks, Network, PenLine, RefreshCw, ScrollText, Search, ShieldCheck, Sparkles, Upload, Users, X } from 'lucide-react';
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
  return (
    <div className="result-list">
      {groups.map((group) => (
        <div className="nav-group-block" key={group.key}>
          <div className="nav-sub-head"><span>{group.key}</span><b>{group.items.length}</b></div>
          {group.items.map((node) => (
            <button key={node.id} className={selectedId === node.id ? 'result active' : 'result'} onClick={() => onOpen(node)}>
              <span className="dot" style={{ background: colorFor(node.type) }} />
              <span className="result-main"><b>{node.label}</b><small>{labelFor(node.type)}</small></span>
            </button>
          ))}
        </div>
      ))}
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

function TimelinePanel({ entries, onOpenChapter, onOpenEntity }: { entries: TimelineEntry[]; onOpenChapter: (id: string) => void; onOpenEntity: (id: string) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const H = 292;

  const model = useMemo(() => {
    const celestial = entries.filter((entry) => entry.timePlane === 'celestial_past');
    const rest = entries.filter((entry) => entry.timePlane !== 'celestial_past');
    const parsed = rest.map((entry) => ({ entry, day: parseDay(entry.date) }));
    const dated = parsed.filter((p): p is { entry: TimelineEntry; day: number } => p.day != null);
    const frameYear = (day: number): boolean => new Date(day).getUTCFullYear() >= 2050;
    const mainPts = dated.filter((p) => !frameYear(p.day)).sort((a, b) => a.day - b.day);
    const framePts = dated.filter((p) => frameYear(p.day)).sort((a, b) => a.day - b.day);
    const undated = parsed.filter((p) => p.day == null).map((p) => p.entry);

    const MARGIN = 46;
    const spineY = 234;
    const min = mainPts.length ? mainPts[0].day : 0;
    const max = mainPts.length ? mainPts[mainPts.length - 1].day : 1;
    const span = Math.max(1, max - min);
    const monthMs = 1000 * 60 * 60 * 24 * 30.44;
    const innerW = Math.max(680, Math.round((span / monthMs) * 62));
    const width = innerW + MARGIN * 2;
    const xOf = (day: number): number => MARGIN + ((day - min) / span) * innerW;

    const bucket = new Map<number, number>();
    const staged = mainPts.map((p) => {
      const x = xOf(p.day);
      const key = Math.round(x / 13);
      const stack = bucket.get(key) ?? 0;
      bucket.set(key, stack + 1);
      return { entry: p.entry, day: p.day, x, stack };
    });
    const maxStack = staged.reduce((m, n) => Math.max(m, n.stack), 0);
    const rowH = Math.max(7, Math.min(14, (spineY - 44) / Math.max(1, maxStack)));
    const nodes = staged.map((n) => ({ ...n, y: spineY - 16 - n.stack * rowH }));

    const ticks: { x: number; label: string }[] = [];
    if (mainPts.length) {
      const start = new Date(min);
      let cur = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
      while (cur <= max + monthMs) {
        const d = new Date(cur);
        ticks.push({ x: xOf(cur), label: d.getUTCMonth() === 0 ? `${MONTHS_IT[0]} ${d.getUTCFullYear()}` : MONTHS_IT[d.getUTCMonth()] });
        cur = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      }
    }
    return { nodes, framePts, undated, celestial, width, spineY, MARGIN, ticks };
  }, [entries]);

  const hovered = model.nodes.find((n) => n.entry.id === hover) ?? null;
  const openEntry = (entry: TimelineEntry): void => { if (entry.chapterId) onOpenChapter(entry.chapterId); else onOpenEntity(entry.id); };

  return (
    <div className="novel-panel">
      <div className="novel-head">
        <h2>Timeline del romanzo</h2>
        <p className="novel-sub">
          <b>{entries.length}</b> eventi lungo la spina temporale. Storia principale 2020–2021; cornice 2080 a parte. Hover per il dettaglio, click per aprire il capitolo/evento. L'altezza dei punti segnala i periodi più densi.
        </p>
      </div>
      <div className="tl-legend">
        <span><i className="tl-key main" /> storia principale <b>{model.nodes.length}</b></span>
        <span><i className="tl-key frame" /> cornice 2080 <b>{model.framePts.length}</b></span>
        {model.celestial.length > 0 && <span><i className="tl-key celestial" /> passato celeste <b>{model.celestial.length}</b></span>}
        {model.undated.length > 0 && <span><i className="tl-key none" /> non datati <b>{model.undated.length}</b></span>}
      </div>

      {model.nodes.length > 0 && (
        <div className="tl-scroll">
          <svg className="tl-svg" width={model.width} height={H} viewBox={`0 0 ${model.width} ${H}`} role="img" aria-label="Timeline storia principale">
            <defs>
              <linearGradient id="tlspine" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#e6b450" />
                <stop offset="0.75" stopColor="#c6a06a" />
                <stop offset="1" stopColor="#9b8ce6" />
              </linearGradient>
            </defs>
            {model.ticks.map((t, i) => (
              <g key={i}>
                <line x1={t.x} y1={42} x2={t.x} y2={model.spineY} stroke="#242b3d" strokeWidth="1" strokeDasharray="2 5" />
                <text x={t.x} y={model.spineY + 20} fill="#6a7288" fontSize="10" textAnchor="middle" fontFamily="ui-monospace, monospace">{t.label}</text>
              </g>
            ))}
            <line x1={model.MARGIN} y1={model.spineY} x2={model.width - model.MARGIN} y2={model.spineY} stroke="url(#tlspine)" strokeWidth="3" strokeLinecap="round" />
            {model.nodes.map((n) => {
              const active = hover === n.entry.id;
              return (
                <g key={n.entry.id} className="tl-node" onMouseEnter={() => setHover(n.entry.id)} onMouseLeave={() => setHover((h) => (h === n.entry.id ? null : h))} onClick={() => openEntry(n.entry)}>
                  <line x1={n.x} y1={n.y} x2={n.x} y2={model.spineY} stroke={active ? '#e6b450' : '#39415a'} strokeWidth="1" />
                  <circle cx={n.x} cy={n.y} r={active ? 6.5 : 4.5} fill={active ? '#fff' : '#e6b450'} stroke="#e6b450" strokeWidth={active ? 2 : 0} />
                </g>
              );
            })}
            {hovered && (() => {
              const label = hovered.entry.label.length > 46 ? `${hovered.entry.label.slice(0, 45)}…` : hovered.entry.label;
              const chapter = hovered.entry.chapterId ? `Cap ${hovered.entry.chapterNumber ?? '·'}${hovered.entry.chapterTitle ? ` · ${hovered.entry.chapterTitle}` : ''}` : 'non ancorato a un capitolo';
              const boxW = 250;
              const bx = Math.max(6, Math.min(model.width - boxW - 6, hovered.x - boxW / 2));
              const below = hovered.y < 96;
              const by = below ? hovered.y + 14 : hovered.y - 74;
              return (
                <g className="tl-tip" pointerEvents="none">
                  <rect x={bx} y={by} width={boxW} height={62} rx={8} fill="#0c0f18" stroke="#2a3145" />
                  <text x={bx + 12} y={by + 20} fill="#eaecf2" fontSize="12.5" fontWeight="600">{label}</text>
                  <text x={bx + 12} y={by + 38} fill="#e6b450" fontSize="11" fontFamily="ui-monospace, monospace">{hovered.entry.date ?? '—'}</text>
                  <text x={bx + 12} y={by + 54} fill="#9aa3b8" fontSize="11">{chapter.length > 40 ? `${chapter.slice(0, 39)}…` : chapter}</text>
                </g>
              );
            })()}
          </svg>
        </div>
      )}

      {model.framePts.length > 0 && (
        <section className="novel-block">
          <h3><span className="chapter-plane frame">cornice</span> 2080 <small>{model.framePts.length}</small></h3>
          <div className="tl-frame-rail">
            {model.framePts.map((p) => (
              <button key={p.entry.id} className="tl-chip frame" onClick={() => openEntry(p.entry)}>
                <span className="tl-chip-date">{p.entry.date ?? '—'}</span>
                {p.entry.label}
              </button>
            ))}
          </div>
        </section>
      )}

      {model.celestial.length > 0 && (
        <section className="novel-block">
          <h3><span className="chapter-plane celestial">passato celeste</span> pre-storia <small>{model.celestial.length}</small></h3>
          <p className="novel-note">Eventi del passato angelico (pre-2020) fuori dalla cronologia terrena: si "sbloccano" quando i personaggi ne prendono consapevolezza. Collegati a Gabriel/Lisa e ancorati via <span className="edge-kind">revealed_in</span> al capitolo della rivelazione.</p>
          <div className="tl-frame-rail">
            {model.celestial.map((entry) => (
              <button key={entry.id} className="tl-chip celestial" onClick={() => openEntry(entry)}>{entry.label}</button>
            ))}
          </div>
        </section>
      )}

      {model.undated.length > 0 && (
        <section className="novel-block">
          <h3>Eventi non datati <small>{model.undated.length}</small></h3>
          <p className="novel-note">Senza data derivabile dal capitolo collegato — candidati alla bonifica (ancoraggio a un capitolo).</p>
          <div className="tl-frame-rail">
            {model.undated.slice(0, 60).map((entry) => (
              <button key={entry.id} className="tl-chip none" onClick={() => openEntry(entry)}>{entry.label}</button>
            ))}
            {model.undated.length > 60 && <span className="muted">+{model.undated.length - 60} altri</span>}
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
      { id: 'prosa-canon', title: 'Estrazione prosa → canone', body: 'Dalla versione approvata del {CAPITOLO} estrai i nuovi dettagli canonici emersi nella prosa (fatti, oggetti, luoghi, relazioni, date, stati dei personaggi) e proponimeli come nodi/archi da consolidare nel modello neurale, con provenienza "chapter-{N}-draft". Prima di scrivere, segnala eventuali contraddizioni col canone esistente e attendi conferma.' },
    ],
  },
];

function EditorialePanel({ drafts, characters, onOpen }: { drafts: KgNode[]; characters: KgNode[]; onOpen: (id: string, type: string) => void }) {
  const [persona, setPersona] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
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
  const copyPrompt = (id: string, body: string): void => {
    const text = persona ? body.replaceAll('{PERSONAGGIO}', persona) : body;
    void navigator.clipboard?.writeText(text);
    setCopied(id);
  };
  return (
    <div className="novel-panel">
      <div className="novel-head">
        <h2>Cockpit Editoriale</h2>
        <p className="novel-sub">
          Prompt pronti da incollare in chat con il modello collegato al grafo via <span className="edge-kind">MCP</span>: sfruttano il modello neurale in stesura e revisione. La valutazione qualitativa della prosa avviene in chat sul canone (ground truth); la pipeline <span className="edge-kind">novel_*</span> persiste bozze e decisioni. Il FE resta di sola lettura.
        </p>
      </div>

      <section className="novel-block">
        <h3>Prompt preimpostati</h3>
        <div className="persona-pick">
          <label>Personaggio da impersonare</label>
          <select value={persona} onChange={(event) => setPersona(event.target.value)}>
            <option value="">— nessuno (lascio il segnaposto) —</option>
            {charGroups.map((group) => (
              <optgroup key={group.key} label={group.key}>
                {group.items.map((node) => <option key={node.id} value={node.label}>{node.label}</option>)}
              </optgroup>
            ))}
          </select>
          <span className="persona-hint">sostituisce <code>{'{PERSONAGGIO}'}</code> alla copia. Impersonabile ogni personaggio: protagonisti, principali, forze sovrannaturali, secondari e cornice, o chi compare esplicitamente nel capitolo.</span>
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
                  <p className="prompt-body">{persona ? prompt.body.replaceAll('{PERSONAGGIO}', persona) : prompt.body}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>

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
  const [themes, setThemes] = useState<KgNode[]>([]);
  const [styleGuide, setStyleGuide] = useState<KgNode[]>([]);
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
    setTab((current) => ENTITY_TAB[type] ?? (KEEP_TAB.has(current) ? current : 'personaggio'));
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
            <button className={tab === 'temi' ? 'active' : ''} onClick={() => { setTab('temi'); void loadThemes(); }}><Sparkles size={15} />Temi</button>
            <button className={tab === 'stile' ? 'active' : ''} onClick={() => { setTab('stile'); void loadStyle(); }}><Feather size={15} />Stile &amp; Regole</button>
          </div>
          <div className="nav-group">Lavoro</div>
          <div className="tabs" role="tablist">
            <button className={tab === 'editoriale' ? 'active' : ''} onClick={() => { setTab('editoriale'); void loadDrafts(); void loadCharacters(); }}><PenLine size={15} />Editoriale</button>
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
            <CoerenzaPanel health={health} onOpenPoints={() => { setTab('openPoints'); void loadOpenPoints(); }} />
          ) : tab === 'editoriale' ? (
            <EditorialePanel drafts={drafts} characters={characters} onOpen={(id, type) => void openEntity(id, type)} />
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
