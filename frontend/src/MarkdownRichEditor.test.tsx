import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from 'prosemirror-view';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownRichEditor } from './MarkdownRichEditor';

function editor(): HTMLElement {
  return screen.getByRole('textbox', { name: 'Testo bozza' });
}

describe('MarkdownRichEditor', () => {
  it('renders Markdown as semantic rich text without visible delimiters', () => {
    const { container } = render(
      <MarkdownRichEditor value="# Titolo\n\nTesto *corsivo* e **grassetto**." onChange={vi.fn()} ariaLabel="Testo bozza" />,
    );
    expect(container.querySelector('h1')).toHaveTextContent('Titolo');
    expect(editor().querySelector('em')).toHaveTextContent('corsivo');
    expect(editor().querySelector('strong')).toHaveTextContent('grassetto');
    expect(editor()).not.toHaveTextContent('*corsivo*');
    expect(editor()).not.toHaveTextContent('**grassetto**');
  });

  it('emits Markdown for document changes, supports Mod-b/Mod-i and undo', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MarkdownRichEditor value="" onChange={onChange} ariaLabel="Testo bozza" />);
    const surface = editor();
    surface.focus();
    await user.keyboard('{Control>}b{/Control}');
    await user.type(surface, 'forte', { skipClick: true });
    expect(onChange).toHaveBeenLastCalledWith('**forte**');
    await user.keyboard('{Control>}b{/Control}{Control>}i{/Control}');
    await user.type(surface, ' corsivo', { skipClick: true });
    expect(onChange.mock.calls.at(-1)?.[0]).toContain('*corsivo*');
    await user.keyboard('{Control>}z{/Control}');
    expect(editor()).not.toHaveTextContent('corsivo');
  });

  it('applies external values without callback loops and exposes a real disabled state', () => {
    const onChange = vi.fn();
    const { rerender } = render(<MarkdownRichEditor value="prima" onChange={onChange} ariaLabel="Testo bozza" />);
    rerender(<MarkdownRichEditor value="**seconda**" onChange={onChange} ariaLabel="Testo bozza" disabled />);
    expect(editor()).toHaveTextContent('seconda');
    expect(editor()).toHaveAttribute('contenteditable', 'false');
    expect(editor()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Grassetto' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Corsivo' })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('destroys the ProseMirror view on unmount', () => {
    const destroy = vi.spyOn(EditorView.prototype, 'destroy');
    const { unmount } = render(<MarkdownRichEditor value="testo" onChange={vi.fn()} ariaLabel="Testo bozza" />);
    unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
    destroy.mockRestore();
  });

  it('sanitizes actual HTML clipboard content before it reaches the document', () => {
    const onChange = vi.fn();
    const { container } = render(<MarkdownRichEditor value="" onChange={onChange} ariaLabel="Testo bozza" />);
    const clipboardData = {
      getData: (type: string) => type === 'text/html'
        ? '<img src="https://example.com/tracker.png" alt="copertina"><a href="javascript:alert(1)">cattivo</a> <a href="https://example.com/sicuro">sicuro</a>'
        : 'copertina cattivo sicuro',
      types: ['text/html', 'text/plain'],
    };
    fireEvent.paste(editor(), { clipboardData });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector('a[href="https://example.com/sicuro"]')).toHaveTextContent('sicuro');
    expect(editor()).toHaveTextContent('copertina');
    expect(editor()).toHaveTextContent('cattivo');
    const markdown = String(onChange.mock.calls.at(-1)?.[0] ?? '');
    expect(markdown).not.toContain('![');
    expect(markdown).not.toContain('javascript:');
    expect(markdown).toContain('[sicuro](https://example.com/sicuro)');
  });
});
