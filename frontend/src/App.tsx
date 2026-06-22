import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { Database, FileText, Network, RefreshCw, Search, X } from 'lucide-react';
import { getKgNeighbors, getKgNode, getKgStats, listKgDocuments, searchKg, type KgEdge, type KgNode, type KgStats } from './api';

const TYPE_COLORS: Record<string, string> = {
  document: '#2563eb',
  chunk: '#64748b',
  person: '#16a34a',
  place: '#d97706',
  organization: '#db2777',
  event: '#dc2626',
  concept: '#7c3aed',
  procedure: '#0891b2',
  decision: '#4f46e5',
  ticket: '#ea580c',
  thread: '#0d9488',
  note: '#475569',
};

const colorFor = (type: string): string => TYPE_COLORS[type] ?? '#334155';

type Tab = 'search' | 'documents';

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

function StatBar({ stats }: { stats: KgStats | null }) {
  const topTypes = useMemo(() => Object.entries(stats?.nodeTypes ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8), [stats]);
  return (
    <div className="statbar" aria-label="Statistiche grafo">
      <span className="stat"><Database size={15} />{stats?.nodes ?? 0}</span>
      <span className="stat"><Network size={15} />{stats?.edges ?? 0}</span>
      {topTypes.map(([type, count]) => (
        <span className="type-stat" key={type}>
          <span className="dot" style={{ background: colorFor(type) }} />
          {type}<b>{count}</b>
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
  const [graph, setGraph] = useState<{ nodes: GNode[]; links: GLink[] }>({ nodes: [], links: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KgNode | null>(null);
  const [tab, setTab] = useState<Tab>('search');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const graphRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ width: 900, height: 640 });

  const refreshStats = useCallback(async () => {
    setStats(await getKgStats());
  }, []);

  useEffect(() => {
    void refreshStats().catch((err) => setError(String(err)));
  }, [refreshStats]);

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
    if (!q) return;
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
  }, [query, typeFilter]);

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

  const activeList = tab === 'search' ? results : documents;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Rete Neurale Romanzo Gabriele</p>
          <h1>Rete neurale</h1>
        </div>
        <button className="icon-button" title="Aggiorna statistiche" onClick={() => void refreshStats()}>
          <RefreshCw size={18} />
        </button>
      </header>

      <StatBar stats={stats} />

      <main className="workspace">
        <aside className="sidebar">
          <div className="tabs" role="tablist">
            <button className={tab === 'search' ? 'active' : ''} onClick={() => setTab('search')}><Search size={15} />Nodi</button>
            <button className={tab === 'documents' ? 'active' : ''} onClick={() => { setTab('documents'); void loadDocuments(); }}><FileText size={15} />Documenti</button>
          </div>

          {tab === 'search' && (
            <div className="search-box">
              <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(); }} placeholder="Cerca" />
              <input value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(); }} placeholder="type" />
              <button className="icon-button primary" title="Cerca" onClick={() => void runSearch()}><Search size={18} /></button>
            </div>
          )}

          {error && <div className="error-line">{error}</div>}
          {loading && <div className="loading-line">Caricamento</div>}

          <div className="result-list">
            {activeList.map((node) => (
              <button key={node.id} className={selectedId === node.id ? 'result active' : 'result'} onClick={() => void expandNode(node.id)}>
                <span className="dot" style={{ background: colorFor(node.type) }} />
                <span className="result-main"><b>{node.label}</b><small>{node.type}</small></span>
              </button>
            ))}
            {!activeList.length && !loading && <div className="empty-state">Nessun elemento</div>}
          </div>
        </aside>

        <section className="graph-panel" ref={graphRef}>
          {graph.nodes.length > 0 ? (
            <ForceGraph2D<GNode, GLink>
              width={dims.width}
              height={dims.height}
              graphData={graph}
              nodeId="id"
              nodeLabel={(node) => `${node.label} - ${node.type}`}
              nodeColor={(node) => colorFor(node.type)}
              nodeRelSize={5}
              linkLabel={(link) => link.kind}
              linkColor={() => 'rgba(71, 85, 105, 0.36)'}
              linkDirectionalArrowLength={4}
              linkDirectionalArrowRelPos={1}
              onNodeClick={(node) => void expandNode(node.id)}
            />
          ) : (
            <div className="graph-empty">Nessun grafo</div>
          )}

          {detail && (
            <aside className="detail-panel">
              <button className="close-button" title="Chiudi" onClick={() => setDetail(null)}><X size={18} /></button>
              <span className="node-type"><span className="dot" style={{ background: colorFor(detail.type) }} />{detail.type}</span>
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
