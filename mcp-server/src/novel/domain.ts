export const NOVEL_NODE_TYPES = [
  'bible_candidate',
  'bible_coverage_finding',
  'bible_mapping_batch',
  'bible_outline',
  'bible_section',
  'chapter',
  'chapter_block',
  'chapter_draft',
  'character',
  'character_state',
  'character_voice',
  'continuity_finding',
  'editing_session',
  'editorial_decision',
  'editorial_finding',
  'foreshadowing',
  'generated_image',
  'glossary_term',
  'image_prompt',
  'location',
  'manuscript',
  'plot_thread',
  'relationship_dynamic',
  'rewrite_block',
  'scene',
  'seam_review',
  'style_rule',
  'theme',
  'timeline_event',
  'typesetting_pass',
  'visual_brief',
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

export const EDITING_STEP_IDS = ['step1_continuity', 'step2_style', 'step3_rewrite', 'step4_seams', 'step5_typesetting', 'step6_art'] as const;
export type EditingStepId = typeof EDITING_STEP_IDS[number];

export const EDITORIAL_FINDING_CATEGORIES = [
  'continuity_red',
  'continuity_yellow',
  'continuity_green',
  'grammar_syntax',
  'repetition',
  'show_dont_tell',
  'rhythm',
  'dialogue',
  'macro_editing',
  'seam',
  'typesetting',
  'visual',
  'other',
] as const;
export type EditorialFindingCategory = typeof EDITORIAL_FINDING_CATEGORIES[number];

export const EDITORIAL_DECISION_STATUSES = ['pending', 'approved', 'rejected', 'deferred', 'applied'] as const;
export type EditorialDecisionStatus = typeof EDITORIAL_DECISION_STATUSES[number];

export function normalizeChapterLabel(chapterNumber: number): string {
  return `Capitolo ${chapterNumber}`;
}
