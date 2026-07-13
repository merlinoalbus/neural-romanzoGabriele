import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw, Save } from 'lucide-react';
import {
  ApiError,
  getEditorDraft,
  isDraftVersionConflict,
  saveEditorDraft,
  type ChapterSummary,
  type DraftLengthGate,
  type DraftVersionConflictDetails,
  type EditorChapterDraft,
  type EditorDraftResponse,
} from './api';
import { MarkdownRichEditor } from './MarkdownRichEditor';

type EditorPhase = 'idle' | 'loading' | 'ready' | 'refreshing' | 'saving' | 'forcing' | 'conflict';

interface ChapterDraftEditorProps {
  chapter: ChapterSummary | null;
  sessionId: string;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
}

interface PendingMutation {
  kind: 'save' | 'force';
  clientMutationId: string;
  content: string;
  expectedContentHash: string;
  expectedRevision: number;
}

function countWords(content: string): number {
  const normalized = content.trim();
  return normalized ? normalized.split(/\s+/u).length : 0;
}

function mutationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('it-IT');
}

function lengthGateState(gate: DraftLengthGate | null | undefined): boolean | null {
  if (!gate) return null;
  if (typeof gate.ok === 'boolean') return gate.ok;
  if (typeof gate.valid === 'boolean') return gate.valid;
  if (typeof gate.passed === 'boolean') return gate.passed;
  if (typeof gate.withinRange === 'boolean') return gate.withinRange;
  return null;
}

function lengthGateLabel(gate: DraftLengthGate | null | undefined): string | null {
  if (!gate) return null;
  if (typeof gate.message === 'string' && gate.message.trim()) return gate.message;
  const state = lengthGateState(gate);
  const ratio = typeof gate.ratio === 'number' ? ` · ${(gate.ratio * 100).toFixed(1)}%` : '';
  if (state === true) return `Gate di lunghezza rispettato${ratio}`;
  if (state === false) return `Gate di lunghezza non rispettato${ratio}`;
  return `Gate di lunghezza verificato${ratio}`;
}

function liveLengthGate(
  gate: DraftLengthGate | null | undefined,
  currentWords: number,
  dirty: boolean,
): DraftLengthGate | null {
  if (!gate) return null;
  if (typeof gate.baselineWords !== 'number' || !Number.isFinite(gate.baselineWords)) {
    // Older servers cannot provide a live baseline: hide their last response as soon as the
    // textarea changes, rather than presenting a stale result as if it described local prose.
    return dirty ? null : gate;
  }
  const baselineWords = Math.max(0, Math.trunc(gate.baselineWords));
  const minWords = Math.ceil(baselineWords * 0.85);
  const maxWords = Math.floor(baselineWords * 1.4);
  const ratio = baselineWords > 0 ? currentWords / baselineWords : currentWords === 0 ? 1 : 0;
  const ok = baselineWords === 0
    ? currentWords === 0
    : currentWords >= minWords && currentWords <= maxWords;
  return {
    ...gate,
    baselineWords,
    currentWords,
    minWords,
    maxWords,
    ratio,
    ok,
    valid: ok,
    message: ok
      ? `Gate live rispettato: ${currentWords} parole (${minWords}–${maxWords}).`
      : `Gate live non rispettato: ${currentWords} parole, intervallo consentito ${minWords}–${maxWords}.`,
  };
}

function isUncertainSaveError(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 408 || error.status >= 500;
  return true;
}

function sameMutation(
  pending: PendingMutation | null,
  kind: PendingMutation['kind'],
  content: string,
  expectedContentHash: string,
  expectedRevision: number,
): pending is PendingMutation {
  return pending?.kind === kind
    && pending.content === content
    && pending.expectedContentHash === expectedContentHash
    && pending.expectedRevision === expectedRevision;
}

export function ChapterDraftEditor({ chapter, sessionId, onDirtyChange, onSaved }: ChapterDraftEditorProps) {
  const chapterNumber = chapter?.number ?? null;
  const normalizedSessionId = sessionId.trim();
  const [snapshot, setSnapshot] = useState<EditorChapterDraft | null>(null);
  const [content, setContent] = useState('');
  const [baseline, setBaseline] = useState('');
  const [phase, setPhase] = useState<EditorPhase>('idle');
  const [conflict, setConflict] = useState<DraftVersionConflictDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<EditorDraftResponse | null>(null);
  const requestSequence = useRef(0);
  const uncertainMutation = useRef<PendingMutation | null>(null);

  const targetReady = chapterNumber !== null && normalizedSessionId.length > 0;
  const dirty = snapshot !== null && content !== baseline;
  const busy = phase === 'loading' || phase === 'refreshing' || phase === 'saving' || phase === 'forcing';
  const words = useMemo(() => countWords(content), [content]);
  const hasContent = content.trim().length > 0;
  const displayedGate = useMemo(
    () => liveLengthGate(lastResult?.lengthGate, words, dirty),
    [dirty, lastResult?.lengthGate, words],
  );
  const gateLabel = lengthGateLabel(displayedGate);
  const gateState = lengthGateState(displayedGate);
  const auditCurrent = !dirty && !conflict
    && snapshot?.auditStatus === 'passed'
    && snapshot.auditContentHash === snapshot.contentHash
    && snapshot.auditRevision === snapshot.revision;

  useEffect(() => {
    requestSequence.current += 1;
    setSnapshot(null);
    setContent('');
    setBaseline('');
    setConflict(null);
    setError(null);
    setLastResult(null);
    setPhase('idle');
    uncertainMutation.current = null;
  }, [chapterNumber, normalizedSessionId]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => {
    requestSequence.current += 1;
    uncertainMutation.current = null;
    onDirtyChange?.(false);
  }, [onDirtyChange]);

  useEffect(() => {
    if (!dirty) return undefined;
    const warnBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [dirty]);

  const applyRemote = useCallback((response: EditorDraftResponse): void => {
    if (!response.draft) throw new Error('Nessuna bozza disponibile per questa sessione.');
    uncertainMutation.current = null;
    setSnapshot(response.draft);
    setContent(response.draft.content);
    setBaseline(response.draft.content);
    setConflict(null);
    setError(null);
    setLastResult(response);
    setPhase('ready');
  }, []);

  const loadRemote = useCallback(async (discardLocal: boolean): Promise<void> => {
    if (!targetReady || chapterNumber === null) return;
    if (dirty && !discardLocal) {
      const confirmed = window.confirm('La bozza contiene modifiche non salvate. Ricaricare dal server e perderle?');
      if (!confirmed) return;
    }
    const requestId = ++requestSequence.current;
    setPhase(snapshot ? 'refreshing' : 'loading');
    setError(null);
    try {
      const response = await getEditorDraft(chapterNumber, normalizedSessionId);
      if (requestId !== requestSequence.current) return;
      applyRemote(response);
    } catch (err) {
      if (requestId !== requestSequence.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase(snapshot ? 'ready' : 'idle');
    }
  }, [applyRemote, chapterNumber, dirty, normalizedSessionId, snapshot, targetReady]);

  const mutationAttempt = useCallback((
    kind: PendingMutation['kind'],
    expectedContentHash: string,
    expectedRevision: number,
  ): PendingMutation => {
    const pending = uncertainMutation.current;
    if (sameMutation(pending, kind, content, expectedContentHash, expectedRevision)) return pending;
    return {
      kind,
      clientMutationId: mutationId(),
      content,
      expectedContentHash,
      expectedRevision,
    };
  }, [content]);

  const persist = useCallback(async (attempt: PendingMutation): Promise<void> => {
    if (!targetReady || chapterNumber === null || !snapshot || !attempt.content.trim()) return;
    const explicitForce = attempt.kind === 'force';
    const requestId = ++requestSequence.current;
    setPhase(explicitForce ? 'forcing' : 'saving');
    setError(null);
    try {
      const response = await saveEditorDraft({
        chapterNumber,
        sessionId: normalizedSessionId,
        content: attempt.content,
        expectedContentHash: attempt.expectedContentHash,
        expectedRevision: attempt.expectedRevision,
        clientMutationId: attempt.clientMutationId,
        changeSummary: explicitForce
          ? 'Sovrascrittura della versione locale confermata esplicitamente dall’utente nel Cockpit editoriale.'
          : 'Salvataggio manuale dal Cockpit editoriale.',
      });
      if (requestId !== requestSequence.current) return;
      applyRemote(response);
      onSaved?.();
    } catch (err) {
      if (requestId !== requestSequence.current) return;
      if (isDraftVersionConflict(err)) {
        uncertainMutation.current = null;
        setConflict(err.conflict);
        setPhase('conflict');
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (isUncertainSaveError(err)) {
        uncertainMutation.current = attempt;
        setError(`${message} L’esito del salvataggio è incerto: riprovando verrà riusato lo stesso identificatore.`);
      } else {
        uncertainMutation.current = null;
        setError(message);
      }
      setPhase('ready');
    }
  }, [applyRemote, chapterNumber, normalizedSessionId, onSaved, snapshot, targetReady]);

  const saveNormally = useCallback((): void => {
    if (!snapshot || !dirty || busy || conflict || !hasContent) return;
    void persist(mutationAttempt('save', snapshot.contentHash, snapshot.revision));
  }, [busy, conflict, dirty, hasContent, mutationAttempt, persist, snapshot]);

  const forceLocal = useCallback((): void => {
    if (!conflict || busy || !hasContent) return;
    // This is deliberately another compare-and-swap against the version observed in the 409.
    // If that version has changed again, the server returns a fresh conflict; there is no bypass.
    void persist(mutationAttempt('force', conflict.current.contentHash, conflict.current.revision));
  }, [busy, conflict, hasContent, mutationAttempt, persist]);

  const reloadAfterConflict = useCallback((): void => {
    // The explicit button copy states that local changes are lost. Fetch again instead of trusting
    // the 409 payload, so a newer remote revision cannot be silently skipped.
    void loadRemote(true);
  }, [loadRemote]);

  const changeContent = useCallback((nextContent: string): void => {
    if (uncertainMutation.current?.content !== nextContent) uncertainMutation.current = null;
    setContent(nextContent);
    setError(null);
  }, []);

  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      if (!snapshot || !dirty || busy || conflict) return;
      if (!hasContent) return;
      saveNormally();
    };
    window.addEventListener('keydown', saveShortcut);
    return () => window.removeEventListener('keydown', saveShortcut);
  }, [busy, conflict, dirty, hasContent, saveNormally, snapshot]);

  if (!chapter) {
    return <p className="draft-editor-empty">Scegli una sezione per aprire l’editor della bozza.</p>;
  }
  if (chapterNumber === null) {
    return <p className="draft-editor-empty">L’editor delle bozze è disponibile soltanto per i capitoli numerati.</p>;
  }
  if (!normalizedSessionId) {
    return <p className="draft-editor-empty">Inserisci il sessionId editoriale per caricare la bozza del Capitolo {chapterNumber}.</p>;
  }

  const statusClass = conflict ? 'conflict' : dirty ? 'dirty' : snapshot ? 'clean' : 'idle';
  const statusText = conflict
    ? 'Conflitto con una versione più recente'
    : dirty
      ? 'Modifiche non salvate'
      : snapshot
        ? 'Bozza allineata al server'
        : 'Bozza non caricata';

  return (
    <div className="draft-editor">
      <div className="draft-editor-toolbar">
        <div className="draft-editor-heading">
          <div>
            <b>Capitolo {chapterNumber} — {chapter.title}</b>
            <small>Sessione <code>{normalizedSessionId}</code></small>
          </div>
          <span className={`draft-editor-status ${statusClass}`} aria-live="polite">{statusText}</span>
        </div>
        <div className="draft-editor-actions">
          {!snapshot ? (
            <button type="button" className="draft-editor-button" disabled={busy} onClick={() => void loadRemote(false)}>
              <RefreshCw size={15} className={phase === 'loading' ? 'spin' : ''} /> Carica bozza
            </button>
          ) : (
            <button type="button" className="draft-editor-button" disabled={busy || Boolean(conflict)} onClick={() => void loadRemote(false)}>
              <RefreshCw size={15} className={phase === 'refreshing' ? 'spin' : ''} /> Aggiorna
            </button>
          )}
          <button
            type="button"
            className="draft-editor-button primary"
            disabled={!dirty || busy || Boolean(conflict) || !hasContent}
            onClick={saveNormally}
            title={!hasContent && snapshot ? 'Il capitolo non può essere vuoto.' : undefined}
          >
            <Save size={15} /> {phase === 'saving' ? 'Salvataggio…' : 'Salva'}
          </button>
        </div>
      </div>

      {conflict && (
        <div className="draft-conflict" role="alert">
          <div className="draft-conflict-copy">
            <AlertTriangle size={20} />
            <div>
              <b>La bozza sul server è cambiata.</b>
              <p>Il testo locale è stato conservato. Scegli esplicitamente quale versione mantenere; non verrà eseguito alcun merge automatico.</p>
              <small>Versione remota: revisione {conflict.current.revision}, aggiornata {formatUpdatedAt(conflict.current.updatedAt)}.</small>
            </div>
          </div>
          <div className="draft-conflict-actions">
            <button
              type="button"
              className="draft-editor-button danger"
              disabled={busy || !hasContent}
              onClick={forceLocal}
              title={!hasContent ? 'Il capitolo non può essere vuoto.' : undefined}
            >
              {phase === 'forcing' ? 'Nuovo controllo…' : 'Forza la mia versione'}
            </button>
            <button type="button" className="draft-editor-button" disabled={busy} onClick={reloadAfterConflict}>
              Ricarica versione aggiornata <span>— perdi le modifiche locali</span>
            </button>
          </div>
        </div>
      )}

      {error && <div className="draft-editor-error" role="alert">{error}</div>}
      {snapshot && !hasContent && (
        <div className="draft-editor-validation" role="status">
          Il capitolo non può essere vuoto: inserisci almeno un carattere non vuoto prima di salvare.
        </div>
      )}

      <MarkdownRichEditor
        value={content}
        disabled={!snapshot || busy}
        onChange={changeContent}
        ariaLabel={`Testo della bozza del Capitolo ${chapterNumber}`}
        placeholder={phase === 'loading' ? 'Caricamento della bozza…' : 'Carica la bozza per iniziare a lavorare sul testo.'}
      />

      <div className="draft-editor-footer">
        <span>{words.toLocaleString('it-IT')} parole · {content.length.toLocaleString('it-IT')} caratteri</span>
        {snapshot && <span>rev. {snapshot.revision} · hash <code>{snapshot.contentHash.slice(0, 12)}</code> · {formatUpdatedAt(snapshot.updatedAt)}</span>}
        {snapshot && (
          <span className={auditCurrent ? 'ok' : snapshot.auditStatus === 'failed' ? 'bad' : ''}>
            {auditCurrent ? 'Audit corrente superato' : snapshot.auditStatus === 'failed' ? 'Audit fallito: rieseguire l’ingest' : 'Audit da rieseguire prima della canonizzazione'}
          </span>
        )}
        {lastResult?.historyCount !== undefined && <span>{lastResult.historyCount} versioni disponibili · corrente inclusa</span>}
        {gateLabel && <span className={gateState === false ? 'bad' : gateState === true ? 'ok' : ''}>{gateLabel}</span>}
        <span className="draft-editor-shortcut">Ctrl/Cmd+S per salvare</span>
      </div>
    </div>
  );
}
