import { describe, expect, it } from 'vitest';
import { defaultMarkdownParser } from 'prosemirror-markdown';
import {
  isSafeLinkHref,
  parseMarkdownDraft,
  serializeMarkdownDraft,
} from './markdownDraft';

describe('markdown draft codec', () => {
  it('round-trips every supported structural construct', () => {
    const samples = [
      '*corsivo* e **grassetto**',
      '# Titolo\n\n## Sottotitolo',
      '- uno\n- due\n\n1. primo\n2. secondo',
      '> citazione\n> su due righe',
      '[OpenAI](https://openai.com) e `codice`',
      '```ts\nconst value = 1;\n```',
      'prima riga\\\nseconda riga',
    ];
    for (const markdown of samples) {
      const parsed = parseMarkdownDraft(markdown);
      expect(parseMarkdownDraft(serializeMarkdownDraft(parsed)).eq(parsed)).toBe(true);
    }
  });

  it('uses a positive URL allowlist and rejects active or ambiguous protocols', () => {
    expect(isSafeLinkHref('https://example.com')).toBe(true);
    expect(isSafeLinkHref('HTTP://example.com')).toBe(true);
    expect(isSafeLinkHref('mailto:test@example.com')).toBe(true);
    expect(isSafeLinkHref('/capitolo/2')).toBe(true);
    expect(isSafeLinkHref('../indice')).toBe(true);
    expect(isSafeLinkHref('#sezione')).toBe(true);
    expect(isSafeLinkHref('javascript:alert(1)')).toBe(false);
    expect(isSafeLinkHref(' data:text/html,testo ')).toBe(false);
    expect(isSafeLinkHref('//example.com')).toBe(false);
    expect(isSafeLinkHref('https:\\example.com')).toBe(false);
    expect(isSafeLinkHref('https://example.com\nmalicious')).toBe(false);
  });

  it('removes images and unsafe link marks from external Markdown while preserving text', () => {
    const markdown = [
      '![copertina](https://example.com/image.png)',
      '[pericoloso](javascript:alert(1))',
      '[sicuro](https://example.com)',
      '<script>window.evil = true</script>',
    ].join('\n\n');
    const document = parseMarkdownDraft(markdown);
    const serialized = serializeMarkdownDraft(document);
    expect(document.textContent).toContain('copertina');
    expect(document.textContent).toContain('pericoloso');
    expect(serialized).not.toContain('![');
    expect(serialized).toContain('[sicuro](https://example.com)');
    let hasImage = false;
    let hasUnsafeLink = false;
    defaultMarkdownParser.parse(serialized).descendants((node) => {
      if (node.type.name === 'image') hasImage = true;
      for (const mark of node.marks) {
        if (mark.type.name === 'link' && /^(javascript|data):/iu.test(String(mark.attrs.href))) hasUnsafeLink = true;
      }
      return true;
    });
    expect(hasImage).toBe(false);
    expect(hasUnsafeLink).toBe(false);
  });
});
