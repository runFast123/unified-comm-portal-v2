// Tests for the smart-inbox sidebar URL helpers — pure round-trip math.
//
// These run in the node env (no DOM) — `URLSearchParams` is built into Node.

import { describe, it, expect } from 'vitest'

import {
  readFacetFiltersFromSearch,
  writeFacetFiltersToSearch,
  type FacetActiveFilters,
} from '@/lib/inbox-facets'

describe('readFacetFiltersFromSearch', () => {
  it('returns empty object when no facet params are present', () => {
    const sp = new URLSearchParams('view=abc&filter=pending')
    expect(readFacetFiltersFromSearch(sp)).toEqual({})
  })

  it('reads the whitelisted facet keys', () => {
    const sp = new URLSearchParams(
      'category=Support&sentiment=negative&urgency=high&channel=email&status=active&assignment=me',
    )
    expect(readFacetFiltersFromSearch(sp)).toEqual({
      category: 'Support',
      sentiment: 'negative',
      urgency: 'high',
      channel: 'email',
      status: 'active',
      assignment: 'me',
    })
  })

  it('treats "all" as unset (matches InboxFiltersBar convention)', () => {
    const sp = new URLSearchParams('category=all&sentiment=positive')
    expect(readFacetFiltersFromSearch(sp)).toEqual({ sentiment: 'positive' })
  })

  it('ignores unknown keys', () => {
    const sp = new URLSearchParams('category=Support&priority=high&foo=bar')
    expect(readFacetFiltersFromSearch(sp)).toEqual({ category: 'Support' })
  })
})

describe('writeFacetFiltersToSearch', () => {
  it('writes facet filters into the search params', () => {
    const sp = new URLSearchParams('')
    const next = writeFacetFiltersToSearch(sp, {
      category: 'Support',
      assignment: 'me',
    })
    expect(next.get('category')).toBe('Support')
    expect(next.get('assignment')).toBe('me')
    expect(next.get('sentiment')).toBeNull()
  })

  it('preserves non-facet params (saved view, dashboard filter, etc.)', () => {
    const sp = new URLSearchParams('view=v123&filter=pending')
    const next = writeFacetFiltersToSearch(sp, { category: 'Support' })
    expect(next.get('view')).toBe('v123')
    expect(next.get('filter')).toBe('pending')
    expect(next.get('category')).toBe('Support')
  })

  it('removes facet params that are no longer in the filter object', () => {
    const sp = new URLSearchParams('category=Support&sentiment=negative&urgency=high')
    const next = writeFacetFiltersToSearch(sp, { category: 'Support' })
    expect(next.get('category')).toBe('Support')
    expect(next.get('sentiment')).toBeNull()
    expect(next.get('urgency')).toBeNull()
  })

  it('round-trips through read/write/read', () => {
    const original: FacetActiveFilters = {
      category: 'Newsletter/Marketing',
      sentiment: 'neutral',
      assignment: 'unassigned',
    }
    const writtenA = writeFacetFiltersToSearch(new URLSearchParams(''), original)
    const readBack = readFacetFiltersFromSearch(writtenA)
    expect(readBack).toEqual(original)
    const writtenB = writeFacetFiltersToSearch(writtenA, readBack)
    expect(writtenB.toString()).toBe(writtenA.toString())
  })

  it('clearing all filters yields an empty query string (when no other params)', () => {
    const sp = new URLSearchParams('category=Support&sentiment=negative')
    const next = writeFacetFiltersToSearch(sp, {})
    expect(next.toString()).toBe('')
  })
})
