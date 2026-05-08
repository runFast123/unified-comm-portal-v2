/**
 * /observability — redirect to /admin/observability.
 *
 * The sidebar correctly links to /admin/observability, but users hand-
 * typing the obvious bare URL (or sharing a copy-pasted link from
 * elsewhere) used to land on the global 404 with the sidebar stripped.
 * This stub redirects them to the canonical admin path.
 */
import { redirect } from 'next/navigation'

export default function ObservabilityRedirect(): never {
  redirect('/admin/observability')
}
