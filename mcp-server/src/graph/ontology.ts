export const KG_RELATION_VOCAB = {
  structural: ['known_as', 'renders_as', 'mentions', 'part_of', 'precedes', 'derived_from', 'about', 'belongs_to', 'has_status'],
  peopleAndOrgs: ['member_of', 'owner_of', 'ally_of', 'enemy_of', 'family_of', 'teacher_of', 'colleague_of', 'leads', 'serves'],
  narrativeAndCausal: [
    'appears_in',
    'causes',
    'changes_state',
    'conceals',
    'constrains',
    'contradicts',
    'defines',
    'depends_on',
    'blocks',
    'foreshadows',
    'has_arc',
    'has_theme',
    'has_voice',
    'motivates',
    'pays_off',
    'resolves',
    'reveals',
    'supports',
  ],
  actions: ['helps', 'assists', 'challenges', 'threatens', 'defeats', 'betrays', 'saves', 'creates', 'modifies'],
  fallback: ['related_to'],
} as const;

export const KG_KINDS: ReadonlySet<string> = new Set(Object.values(KG_RELATION_VOCAB).flat());
export const KG_KINDS_LIST: readonly string[] = [...KG_KINDS].sort();

export function isCanonicalKind(kind: string): boolean {
  return KG_KINDS.has(kind);
}

export function assertCanonicalKind(kind: string): void {
  if (!isCanonicalKind(kind)) {
    throw new Error(`invalid_kind: '${kind}' is not allowed. Allowed kinds: ${KG_KINDS_LIST.join(', ')}`);
  }
}
