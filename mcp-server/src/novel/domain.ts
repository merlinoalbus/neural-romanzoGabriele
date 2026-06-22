export const NOVEL_NODE_TYPES = [
  'bible_outline',
  'bible_section',
  'chapter',
  'chapter_draft',
  'character',
  'character_state',
  'character_voice',
  'continuity_finding',
  'foreshadowing',
  'glossary_term',
  'location',
  'plot_thread',
  'relationship_dynamic',
  'scene',
  'style_rule',
  'theme',
  'timeline_event',
  'world_rule',
] as const;

export type NovelNodeType = typeof NOVEL_NODE_TYPES[number];

export const NOVEL_NODE_TYPE_SET: ReadonlySet<string> = new Set(NOVEL_NODE_TYPES);

export function isNovelNodeType(type: string): type is NovelNodeType {
  return NOVEL_NODE_TYPE_SET.has(type);
}

export const NOVEL_SOURCE_TYPES = {
  outline: 'novel_outline',
  bible: 'novel_bible',
  chapterDraft: 'chapter_draft',
} as const;

export const NOVEL_CANON_STATUSES = ['outline_only', 'canonical', 'draft', 'proposal', 'unknown'] as const;
export type NovelCanonStatus = typeof NOVEL_CANON_STATUSES[number];

export const NOVEL_DRAFT_STATUSES = ['draft', 'revision', 'approved', 'archived'] as const;
export type NovelDraftStatus = typeof NOVEL_DRAFT_STATUSES[number];

export function normalizeChapterLabel(chapterNumber: number): string {
  return `Capitolo ${chapterNumber}`;
}
