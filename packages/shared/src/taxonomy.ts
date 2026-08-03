// ============================================================================
// Category taxonomy — the client-side half of the builder's curated taxonomy
// (scripts/questionbank/build_bank.py). The builder emits category ids of the
// form `cat_tax_<group>__<key>`; this file turns that group slug back into a
// display section for the host's round picker.
//
// Grouping is applied SERVER-side, in the picker projection, so there is
// exactly one implementation of it and the engine tests cover it.
// ============================================================================

/** Display sections for the host's category picker, in render order. */
export const TAXONOMY_GROUPS: readonly { slug: string; label: string }[] = [
  { slug: 'genre', label: 'Genres' },
  { slug: 'decade_pop', label: 'Pop by decade' },
  { slug: 'decade_rock', label: 'Rock by decade' },
  { slug: 'decade_hiphop', label: 'Hip-Hop by decade' },
  { slug: 'decade_rnb', label: 'R&B/Soul by decade' },
  { slug: 'decade_country', label: 'Country by decade' },
  { slug: 'rock_sub', label: 'Rock sub-genres' },
  { slug: 'era', label: 'Hits by era' },
  { slug: 'special', label: 'Special' },
  // Anything that isn't a taxonomy id at all: the bundled sample bank, a legacy
  // `cat_<playlistId>` bank, an old `cat_ai_*` bank. Fully playable, just
  // ungrouped.
  { slug: 'other', label: 'All categories' },
];

const TAXONOMY_ID_RE = /^cat_tax_([a-z0-9_]+)__/;

/** The taxonomy group a bank category belongs to; `'other'` for anything the
 *  new builder didn't produce. Never throws. */
export function parseCategoryGroup(id: string): string {
  const match = TAXONOMY_ID_RE.exec(id ?? '');
  const slug = match?.[1];
  if (!slug) return 'other';
  return TAXONOMY_GROUPS.some((g) => g.slug === slug) ? slug : 'other';
}

/** Display label for a group slug; falls back to the 'other' label. */
export function groupLabel(slug: string): string {
  return (
    TAXONOMY_GROUPS.find((g) => g.slug === slug)?.label ??
    TAXONOMY_GROUPS[TAXONOMY_GROUPS.length - 1]!.label
  );
}
