import crypto from 'node:crypto';
import { NOVEL_SOURCE_TYPES, type NovelNodeType } from './domain.js';

export interface BibleSectionInput {
  sectionId?: string;
  heading: string;
  text: string;
  order: number;
  level?: number;
  path?: string[];
  parentSectionId?: string;
  outlineNumber?: string;
  headingStyle?: string;
  pageStart?: number;
  pageEnd?: number;
  metadata?: Record<string, unknown>;
}

export interface PlannedBibleSection {
  key: string;
  type: NovelNodeType;
  label: string;
  content: string;
  metadata: Record<string, unknown>;
  provenance: Record<string, unknown>;
  parentKey: string;
}

export interface PlannedBibleEdge {
  fromKey: string;
  toKey: string;
  kind: string;
  metadata: Record<string, unknown>;
  provenance: Record<string, unknown>;
}

export interface BibleSectionsPlan {
  sourceId: string;
  sourceType: string;
  root: PlannedBibleSection;
  sections: PlannedBibleSection[];
  edges: PlannedBibleEdge[];
}

export interface BibleSectionPreview {
  sectionKey: string;
  label: string;
  heading: string;
  order: number;
  level: number;
  path: string[];
  parentSectionKey?: string;
  contentHash: string;
  charCount: number;
  wordCount: number;
}

const ROOT_KEY = 'bible-root';

function contentHash(text: string): string {
  return crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n').trim()).digest('hex');
}

function stableKey(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function cleanText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function cleanPath(path: string[] | undefined, heading: string): string[] {
  const cleaned = (path ?? []).map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return cleaned.length ? cleaned : [heading.replace(/\s+/g, ' ').trim()];
}

function sectionRef(section: BibleSectionInput, sourceId: string, path: string[]): string {
  const explicit = section.sectionId?.trim() || section.outlineNumber?.trim();
  if (explicit) return explicit;
  return `auto-${stableKey(`${sourceId}\n${section.order}\n${path.join('/')}\n${section.heading}`)}`;
}

function pathKey(path: string[]): string {
  return path.join('\u001f');
}

function parentFromPath(path: string[], sectionByPath: Map<string, PlannedBibleSection>): string | undefined {
  for (let length = path.length - 1; length > 0; length--) {
    const parent = sectionByPath.get(pathKey(path.slice(0, length)));
    if (parent) return parent.key;
  }
  return undefined;
}

function parentFromLevel(index: number, sections: PlannedBibleSection[]): string | undefined {
  const currentLevel = Number(sections[index].metadata.level ?? 1);
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const candidateLevel = Number(sections[cursor].metadata.level ?? 1);
    if (candidateLevel < currentLevel) return sections[cursor].key;
  }
  return undefined;
}

export function previewBibleSection(section: PlannedBibleSection): BibleSectionPreview {
  return {
    sectionKey: String(section.metadata.sectionKey),
    label: section.label,
    heading: String(section.metadata.heading),
    order: Number(section.metadata.order),
    level: Number(section.metadata.level),
    path: Array.isArray(section.metadata.path) ? section.metadata.path.map(String) : [],
    parentSectionKey: section.parentKey === ROOT_KEY ? undefined : section.parentKey,
    contentHash: String(section.metadata.contentHash),
    charCount: Number(section.metadata.charCount),
    wordCount: Number(section.metadata.wordCount),
  };
}

export function buildBibleSectionsPlan(input: {
  sourceId: string;
  title?: string;
  sections: BibleSectionInput[];
}): BibleSectionsPlan {
  const sourceId = input.sourceId.trim();
  if (!sourceId) throw new Error('invalid_bible_sections: sourceId is required');
  if (!input.sections.length) throw new Error('invalid_bible_sections: at least one section is required');

  const normalized = input.sections
    .map((section, index) => {
      const heading = section.heading.replace(/\s+/g, ' ').trim();
      const text = cleanText(section.text);
      if (!heading) throw new Error(`invalid_bible_section: heading is required at index ${index}`);
      if (!text) throw new Error(`invalid_bible_section: text is required for heading '${heading}'`);
      const order = Math.trunc(Number(section.order));
      if (!Number.isFinite(order) || order < 1) throw new Error(`invalid_bible_section: order must be positive for '${heading}'`);
      const path = cleanPath(section.path, heading);
      const level = Math.max(1, Math.trunc(Number(section.level ?? path.length)));
      const key = sectionRef(section, sourceId, path);
      return { section, heading, text, order, path, level, key };
    })
    .sort((a, b) => a.order - b.order);

  const seenKeys = new Set<string>();
  const sections: PlannedBibleSection[] = [];
  const sectionByAlias = new Map<string, PlannedBibleSection>();
  const sectionByPath = new Map<string, PlannedBibleSection>();
  for (const item of normalized) {
    if (seenKeys.has(item.key)) throw new Error(`invalid_bible_section: duplicate section key '${item.key}'`);
    seenKeys.add(item.key);
    const hash = contentHash(item.text);
    const planned: PlannedBibleSection = {
      key: item.key,
      type: 'bible_section',
      label: `${sourceId}::${item.key}`,
      content: item.text,
      metadata: {
        ...(item.section.metadata ?? {}),
        sourceId,
        sourceType: NOVEL_SOURCE_TYPES.bible,
        sectionKey: item.key,
        sectionId: item.section.sectionId,
        outlineNumber: item.section.outlineNumber,
        heading: item.heading,
        headingStyle: item.section.headingStyle,
        order: item.order,
        level: item.level,
        path: item.path,
        parentSectionId: item.section.parentSectionId,
        pageStart: item.section.pageStart,
        pageEnd: item.section.pageEnd,
        contentHash: hash,
        charCount: item.text.length,
        wordCount: wordCount(item.text),
        canonStatus: 'canonical',
      },
      provenance: { source: 'novel_ingest_bible_sections', sourceId, sectionKey: item.key, contentHash: hash },
      parentKey: ROOT_KEY,
    };
    sections.push(planned);
    sectionByAlias.set(item.key, planned);
    if (item.section.sectionId?.trim()) sectionByAlias.set(item.section.sectionId.trim(), planned);
    if (item.section.outlineNumber?.trim()) sectionByAlias.set(item.section.outlineNumber.trim(), planned);
    sectionByPath.set(pathKey(item.path), planned);
  }

  for (let index = 0; index < sections.length; index++) {
    const section = sections[index];
    const path = section.metadata.path as string[];
    const explicitParent = typeof section.metadata.parentSectionId === 'string' ? section.metadata.parentSectionId.trim() : '';
    section.parentKey = (explicitParent && sectionByAlias.get(explicitParent)?.key) || parentFromPath(path, sectionByPath) || parentFromLevel(index, sections) || ROOT_KEY;
  }

  const title = input.title?.trim() || sourceId;
  const root: PlannedBibleSection = {
    key: ROOT_KEY,
    type: 'bible_outline',
    label: sourceId,
    content: title,
    metadata: {
      sourceId,
      sourceType: NOVEL_SOURCE_TYPES.bible,
      title,
      sectionCount: sections.length,
      canonStatus: 'canonical',
      ingestedAs: 'bible_sections',
    },
    provenance: { source: 'novel_ingest_bible_sections', sourceId },
    parentKey: ROOT_KEY,
  };

  const edges: PlannedBibleEdge[] = sections.map((section) => ({
    fromKey: section.key,
    toKey: section.parentKey,
    kind: 'part_of',
    metadata: {
      sourceId,
      sectionKey: section.key,
      parentSectionKey: section.parentKey === ROOT_KEY ? undefined : section.parentKey,
    },
    provenance: { source: 'novel_ingest_bible_sections', sourceId, sectionKey: section.key },
  }));

  for (let index = 0; index < sections.length - 1; index++) {
    edges.push({
      fromKey: sections[index].key,
      toKey: sections[index + 1].key,
      kind: 'precedes',
      metadata: { sourceId, orderScope: 'document', fromOrder: sections[index].metadata.order, toOrder: sections[index + 1].metadata.order },
      provenance: { source: 'novel_ingest_bible_sections', sourceId, sectionKey: sections[index].key },
    });
  }

  return { sourceId, sourceType: NOVEL_SOURCE_TYPES.bible, root, sections, edges };
}
