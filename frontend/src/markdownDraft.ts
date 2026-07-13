import { Fragment, Node as ProseMirrorNode, Slice } from 'prosemirror-model';
import { defaultMarkdownParser, defaultMarkdownSerializer, schema } from 'prosemirror-markdown';

export const markdownDraftSchema = schema;

export function isSafeLinkHref(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const href = value.trim();
  if (!href || /[\u0000-\u001f\u007f]/u.test(href) || href.includes('\\') || href.startsWith('//')) return false;
  if (/^(https?:|mailto:)/iu.test(href)) return true;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(href)) return false;
  return href.startsWith('/') || href.startsWith('./') || href.startsWith('../') || href.startsWith('#') || href.startsWith('?');
}

function safeMarks(node: ProseMirrorNode) {
  return node.marks.filter((mark) => mark.type !== markdownDraftSchema.marks.link || isSafeLinkHref(mark.attrs.href));
}

function sanitizeNode(node: ProseMirrorNode): ProseMirrorNode[] {
  if (node.type === markdownDraftSchema.nodes.image) {
    const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt.trim() : '';
    return alt ? [markdownDraftSchema.text(alt, safeMarks(node))] : [];
  }
  if (node.isText) return [markdownDraftSchema.text(node.text ?? '', safeMarks(node))];

  const children: ProseMirrorNode[] = [];
  node.forEach((child) => children.push(...sanitizeNode(child)));
  return [node.type.create(node.attrs, Fragment.fromArray(children), safeMarks(node))];
}

export function sanitizeMarkdownDocument(document: ProseMirrorNode): ProseMirrorNode {
  const sanitized = sanitizeNode(document)[0];
  if (!sanitized || sanitized.type !== markdownDraftSchema.topNodeType) {
    throw new Error('invalid_markdown_document: top-level document was not preserved');
  }
  return sanitized;
}

export function sanitizeMarkdownSlice(slice: Slice): Slice {
  const children: ProseMirrorNode[] = [];
  slice.content.forEach((child) => children.push(...sanitizeNode(child)));
  return new Slice(Fragment.fromArray(children), slice.openStart, slice.openEnd);
}

export function parseMarkdownDraft(markdown: string): ProseMirrorNode {
  return sanitizeMarkdownDocument(defaultMarkdownParser.parse(markdown));
}

export function serializeMarkdownDraft(document: ProseMirrorNode): string {
  return defaultMarkdownSerializer.serialize(sanitizeMarkdownDocument(document));
}
