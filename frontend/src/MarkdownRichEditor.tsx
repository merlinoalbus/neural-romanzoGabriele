import { useCallback, useEffect, useRef, useState } from 'react';
import { redo, history, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, toggleMark } from 'prosemirror-commands';
import { EditorState, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import {
  markdownDraftSchema,
  parseMarkdownDraft,
  sanitizeMarkdownSlice,
  serializeMarkdownDraft,
} from './markdownDraft';

interface MarkdownRichEditorProps {
  value: string;
  disabled?: boolean;
  onChange: (markdown: string) => void;
  ariaLabel: string;
  placeholder?: string;
}

function createEditorState(markdown: string): EditorState {
  return EditorState.create({
    doc: parseMarkdownDraft(markdown),
    plugins: [
      history(),
      keymap({
        'Mod-b': toggleMark(markdownDraftSchema.marks.strong),
        'Mod-i': toggleMark(markdownDraftSchema.marks.em),
      }),
      keymap({ 'Mod-z': undo, 'Shift-Mod-z': redo, 'Mod-y': redo }),
      keymap(baseKeymap),
    ],
  });
}

function markIsActive(view: EditorView | null, markName: 'strong' | 'em'): boolean {
  if (!view) return false;
  const mark = markdownDraftSchema.marks[markName];
  const { from, to, empty } = view.state.selection;
  if (empty) return Boolean(mark.isInSet(view.state.storedMarks ?? view.state.selection.$from.marks()));
  return view.state.doc.rangeHasMark(from, to, mark);
}

function updateEditorDom(view: EditorView, ariaLabel: string, placeholder: string, disabled: boolean): void {
  view.dom.setAttribute('role', 'textbox');
  view.dom.setAttribute('aria-multiline', 'true');
  view.dom.setAttribute('aria-label', ariaLabel);
  view.dom.setAttribute('aria-disabled', String(disabled));
  view.dom.setAttribute('spellcheck', 'true');
  view.dom.dataset.placeholder = placeholder;
  view.dom.dataset.empty = String(view.state.doc.textContent.length === 0);
}

export function MarkdownRichEditor({
  value,
  disabled = false,
  onChange,
  ariaLabel,
  placeholder = '',
}: MarkdownRichEditorProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const disabledRef = useRef(disabled);
  const ariaLabelRef = useRef(ariaLabel);
  const placeholderRef = useRef(placeholder);
  const [selectionVersion, setSelectionVersion] = useState(0);

  onChangeRef.current = onChange;
  disabledRef.current = disabled;
  ariaLabelRef.current = ariaLabel;
  placeholderRef.current = placeholder;

  useEffect(() => {
    if (!mountRef.current) return undefined;
    const view = new EditorView(mountRef.current, {
      state: createEditorState(value),
      editable: () => !disabledRef.current,
      transformPasted: sanitizeMarkdownSlice,
      dispatchTransaction(transaction) {
        const nextState = view.state.apply(transaction);
        view.updateState(nextState);
        updateEditorDom(view, ariaLabelRef.current, placeholderRef.current, disabledRef.current);
        setSelectionVersion((current) => current + 1);
        if (transaction.docChanged) onChangeRef.current(serializeMarkdownDraft(nextState.doc));
      },
    });
    viewRef.current = view;
    updateEditorDom(view, ariaLabelRef.current, placeholderRef.current, disabledRef.current);
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // The view lifecycle is intentionally independent from controlled value updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentMarkdown = serializeMarkdownDraft(view.state.doc);
    if (value !== currentMarkdown) view.updateState(createEditorState(value));
    view.setProps({ editable: () => !disabled });
    updateEditorDom(view, ariaLabel, placeholder, disabled);
    setSelectionVersion((current) => current + 1);
  }, [ariaLabel, disabled, placeholder, value]);

  const runCommand = useCallback((command: Command): void => {
    const view = viewRef.current;
    if (!view || disabledRef.current) return;
    command(view.state, view.dispatch, view);
    view.focus();
  }, []);

  const strongActive = markIsActive(viewRef.current, 'strong');
  const emActive = markIsActive(viewRef.current, 'em');
  void selectionVersion;

  return (
    <div className={`markdown-rich-editor${disabled ? ' is-disabled' : ''}`}>
      <div className="markdown-rich-editor-toolbar" role="toolbar" aria-label="Formattazione del testo">
        <button
          type="button"
          disabled={disabled}
          aria-label="Grassetto"
          aria-pressed={strongActive}
          className={strongActive ? 'is-active' : ''}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => runCommand(toggleMark(markdownDraftSchema.marks.strong))}
        >
          <strong>B</strong>
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-label="Corsivo"
          aria-pressed={emActive}
          className={emActive ? 'is-active' : ''}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => runCommand(toggleMark(markdownDraftSchema.marks.em))}
        >
          <em>I</em>
        </button>
        <span>Ctrl/Cmd+B · Ctrl/Cmd+I · Ctrl/Cmd+Z</span>
      </div>
      <div ref={mountRef} className="markdown-rich-editor-surface" />
    </div>
  );
}
