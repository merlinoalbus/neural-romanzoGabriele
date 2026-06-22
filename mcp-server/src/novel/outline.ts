import { NOVEL_SOURCE_TYPES, normalizeChapterLabel, type NovelNodeType } from './domain.js';

export interface OutlineEntry {
  number: string;
  title: string;
  page?: number;
  depth: number;
  parentNumber?: string;
  order: number;
  nodeType: NovelNodeType;
  label: string;
  chapterNumber?: number;
  chapterKind?: 'prologue' | 'chapter' | 'epilogue';
}

export interface PlannedNode {
  key: string;
  type: NovelNodeType;
  label: string;
  content: string;
  metadata: Record<string, unknown>;
  provenance: Record<string, unknown>;
}

export interface PlannedEdge {
  fromKey: string;
  toKey: string;
  kind: string;
  metadata: Record<string, unknown>;
  provenance: Record<string, unknown>;
}

export interface OutlinePlan {
  sourceId: string;
  sourceType: string;
  root: PlannedNode;
  entries: OutlineEntry[];
  nodes: PlannedNode[];
  edges: PlannedEdge[];
}

const outlineNumberPattern = /^\d+(?:\.\d+)*$/;

function cleanTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function parseOutlineLine(rawLine: string, order: number): Omit<OutlineEntry, 'parentNumber' | 'nodeType' | 'label'> | null {
  const line = rawLine.trim();
  if (!line) return null;

  const tabParts = line.split(/\t+/).map((part) => part.trim()).filter(Boolean);
  if (tabParts.length >= 2 && outlineNumberPattern.test(tabParts[0])) {
    const last = tabParts[tabParts.length - 1];
    const page = /^\d+$/.test(last) && tabParts.length >= 3 ? Number(last) : undefined;
    const titleParts = page === undefined ? tabParts.slice(1) : tabParts.slice(1, -1);
    const title = cleanTitle(titleParts.join(' '));
    if (!title) return null;
    const number = tabParts[0];
    return { number, title, page, depth: number.split('.').length, order };
  }

  const match = line.match(/^(\d+(?:\.\d+)*)\s+(.+)$/);
  if (!match) return null;
  const number = match[1];
  const rest = cleanTitle(match[2]);
  const pageMatch = rest.match(/^(.*\S)\s+(\d+)$/);
  const title = pageMatch ? cleanTitle(pageMatch[1]) : rest;
  const page = pageMatch ? Number(pageMatch[2]) : undefined;
  if (!title) return null;
  return { number, title, page, depth: number.split('.').length, order };
}

function parentNumberOf(number: string): string | undefined {
  const parts = number.split('.');
  if (parts.length <= 1) return undefined;
  return parts.slice(0, -1).join('.');
}

function chapterInfo(title: string): Pick<OutlineEntry, 'chapterNumber' | 'chapterKind' | 'label'> | null {
  const chapter = title.match(/^Capitolo\s+(\d+)\s*:?\s*(.*)$/i);
  if (chapter) {
    const chapterNumber = Number(chapter[1]);
    return { chapterNumber, chapterKind: 'chapter', label: normalizeChapterLabel(chapterNumber) };
  }
  if (/^Prologo\b/i.test(title)) return { chapterKind: 'prologue', label: 'Prologo' };
  if (/^Epilogo\b/i.test(title)) return { chapterKind: 'epilogue', label: 'Epilogo' };
  return null;
}

function isCharacterEntry(number: string, title: string): boolean {
  const parts = number.split('.');
  const lowered = title.toLowerCase();
  if (parts[0] !== '3') return false;
  if (parts.length === 2) return !lowered.startsWith('personaggi') && !lowered.startsWith('dossier');
  if (parts.length === 3 && (number.startsWith('3.7.') || number.startsWith('3.8.'))) return true;
  return false;
}

function classifyEntry(number: string, title: string): { nodeType: NovelNodeType; label: string; chapterNumber?: number; chapterKind?: OutlineEntry['chapterKind'] } {
  const chapter = chapterInfo(title);
  if (chapter) return { nodeType: 'chapter', ...chapter };

  const lowered = title.toLowerCase();
  const parts = number.split('.');
  const depth = parts.length;

  if (isCharacterEntry(number, title)) return { nodeType: 'character', label: title };
  if (number.startsWith('2.3.') && depth === 3) return { nodeType: 'theme', label: title.replace(/:$/, '') };
  if (parts[0] === '3' && lowered.includes('voce')) return { nodeType: 'character_voice', label: `${number} ${title}` };
  if (parts[0] === '3' && lowered.includes('relazioni')) return { nodeType: 'relationship_dynamic', label: `${number} ${title}` };
  if (number.startsWith('4.2') || lowered.includes('liceo') || lowered.includes('citta') || lowered.includes('citta/paese') || lowered.includes('luoghi')) {
    return { nodeType: 'location', label: `${number} ${title}` };
  }
  if (number.startsWith('4.3.') && depth >= 3) return { nodeType: 'world_rule', label: `${number} ${title}` };
  if (number.startsWith('5.5.') && depth >= 3) return { nodeType: 'style_rule', label: `${number} ${title}` };
  if (parts[0] === '6' && depth > 1) return { nodeType: 'glossary_term', label: title };

  return { nodeType: 'bible_section', label: `${number} ${title}` };
}

export function parseOutlineEntries(content: string): OutlineEntry[] {
  const parsed = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line, index) => parseOutlineLine(line, index + 1))
    .filter((entry): entry is Omit<OutlineEntry, 'parentNumber' | 'nodeType' | 'label'> => Boolean(entry));

  const seen = new Set<string>();
  const entries: OutlineEntry[] = [];
  for (const entry of parsed) {
    if (seen.has(entry.number)) continue;
    seen.add(entry.number);
    const classified = classifyEntry(entry.number, entry.title);
    entries.push({
      ...entry,
      ...classified,
      parentNumber: parentNumberOf(entry.number),
    });
  }
  return entries;
}

export function buildOutlinePlan(input: { sourceId: string; content: string; sourceType?: string; title?: string }): OutlinePlan {
  const sourceId = input.sourceId.trim();
  if (!sourceId) throw new Error('invalid_outline: sourceId is required');
  const sourceType = input.sourceType ?? NOVEL_SOURCE_TYPES.outline;
  const entries = parseOutlineEntries(input.content);
  const title = input.title?.trim() || sourceId;
  const canonStatus = sourceType === NOVEL_SOURCE_TYPES.bible ? 'canonical' : 'outline_only';
  const root: PlannedNode = {
    key: 'outline-root',
    type: 'bible_outline',
    label: sourceId,
    content: title,
    metadata: {
      sourceId,
      sourceType,
      title,
      entryCount: entries.length,
      canonStatus,
    },
    provenance: { source: 'novel_outline_parser', sourceId },
  };

  const nodes = entries.map<PlannedNode>((entry) => ({
    key: entry.number,
    type: entry.nodeType,
    label: entry.label,
    content: entry.title,
    metadata: {
      sourceId,
      sourceType,
      outlineNumber: entry.number,
      title: entry.title,
      page: entry.page,
      depth: entry.depth,
      parentNumber: entry.parentNumber,
      order: entry.order,
      canonStatus,
      fromOutline: true,
      chapterNumber: entry.chapterNumber,
      chapterKind: entry.chapterKind,
    },
    provenance: { source: 'novel_outline_parser', sourceId, outlineNumber: entry.number },
  }));

  const known = new Set(entries.map((entry) => entry.number));
  const edges: PlannedEdge[] = entries.map((entry) => ({
    fromKey: entry.number,
    toKey: entry.parentNumber && known.has(entry.parentNumber) ? entry.parentNumber : root.key,
    kind: 'part_of',
    metadata: { sourceId, outlineNumber: entry.number },
    provenance: { source: 'novel_outline_parser', sourceId, outlineNumber: entry.number },
  }));

  const previousByParent = new Map<string, OutlineEntry>();
  for (const entry of entries) {
    const parent = entry.parentNumber && known.has(entry.parentNumber) ? entry.parentNumber : root.key;
    const previous = previousByParent.get(parent);
    if (previous) {
      edges.push({
        fromKey: previous.number,
        toKey: entry.number,
        kind: 'precedes',
        metadata: { sourceId, parentNumber: parent === root.key ? undefined : parent },
        provenance: { source: 'novel_outline_parser', sourceId, outlineNumber: entry.number },
      });
    }
    previousByParent.set(parent, entry);
  }

  return { sourceId, sourceType, root, entries, nodes, edges };
}
