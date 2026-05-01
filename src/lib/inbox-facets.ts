// Smart-inbox sidebar URL helpers — extracted into a plain TS module so the
// pure URL <-> filter-state conversion can be unit-tested in the node env
// without dragging in React / TSX.
//
// The matching component (`<InboxFacetsSidebar>`) re-exports these so the
// rest of the codebase can keep importing them from one place.

export type FacetFilterKey =
  | 'category'
  | 'sentiment'
  | 'urgency'
  | 'channel'
  | 'status'
  | 'assignment'

export type FacetActiveFilters = Partial<Record<FacetFilterKey, string>>

const FACET_URL_KEYS: FacetFilterKey[] = [
  'category',
  'sentiment',
  'urgency',
  'channel',
  'status',
  'assignment',
]

/**
 * Read facet filter state from a URLSearchParams instance. Whitelists keys —
 * anything outside the facet vocabulary is ignored. The literal value `"all"`
 * is treated as "no filter" (matches the InboxFiltersBar convention).
 */
export function readFacetFiltersFromSearch(
  search: URLSearchParams,
): FacetActiveFilters {
  const out: FacetActiveFilters = {}
  for (const key of FACET_URL_KEYS) {
    const v = search.get(key)
    if (v && v !== 'all') out[key] = v
  }
  return out
}

/**
 * Returns a NEW URLSearchParams with the facet keys updated to match `filters`.
 * Other keys are preserved as-is so co-existing query params (?view=,
 * ?spam=true, ?filter=, etc.) continue to work.
 */
export function writeFacetFiltersToSearch(
  current: URLSearchParams,
  filters: FacetActiveFilters,
): URLSearchParams {
  const next = new URLSearchParams(current.toString())
  for (const key of FACET_URL_KEYS) {
    next.delete(key)
  }
  for (const [key, value] of Object.entries(filters)) {
    if (value) next.set(key, value)
  }
  return next
}
