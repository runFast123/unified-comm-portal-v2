// ─── POST /api/kb/reindex — (re)build KB embeddings for RAG ─────────────────
//
// Re-embeds the caller-company's active `kb_articles` into `kb_embeddings` so
// vector search (match_kb_chunks / kb-retrieval) has fresh data. Run this after
// editing KB content.
//
// AuthZ: company_admin / super_admin only (requireCompanyAdmin). A super_admin
// may target another tenant with `?company_id=...`; everyone else is locked to
// their own `gate.ctx.companyId` (mirrors the kb_articles RLS scope).
//
// Degrades gracefully: if OPENAI_API_KEY is unset this returns 400 with a clear
// message instead of silently doing nothing — embeddings are the whole point of
// this endpoint, so "not configured" is a real error for THIS route (whereas
// the read path in kb-retrieval just no-ops).
//
// Per article we: split content into ~1000-char chunks, embed them (one batch
// per article), then REPLACE that article's rows (delete existing → insert new)
// on the service-role client. Articles whose embed fails are skipped, not
// fatal, so one bad article never aborts the whole reindex.

import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { requireCompanyAdmin } from '@/lib/tenant-guard'
import { isEmbeddingEnabled, embedBatch } from '@/lib/embeddings'
import { logError, logInfo } from '@/lib/logger'

const MAX_CHUNK_CHARS = 1000

interface KbArticleRow {
  id: string
  company_id: string
  title: string | null
  content: string | null
}

/**
 * Split article text into ~MAX_CHUNK_CHARS chunks WITHOUT a tokenizer lib.
 * Splits on blank lines (paragraphs) first so chunks stay semantically whole;
 * any single paragraph longer than the limit is hard-wrapped by length. The
 * title is prepended to the first chunk so a heading-only match still surfaces
 * the article. Returns [] for empty content.
 */
function chunkContent(title: string | null, content: string | null): string[] {
  const body = (content ?? '').trim()
  if (!body) return []

  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0)

  const chunks: string[] = []
  let current = ''

  const flush = () => {
    const trimmed = current.trim()
    if (trimmed) chunks.push(trimmed)
    current = ''
  }

  for (const para of paragraphs) {
    // A single oversized paragraph: hard-wrap it by length.
    if (para.length > MAX_CHUNK_CHARS) {
      flush()
      for (let i = 0; i < para.length; i += MAX_CHUNK_CHARS) {
        chunks.push(para.slice(i, i + MAX_CHUNK_CHARS))
      }
      continue
    }
    // Would overflow the current chunk → start a new one.
    if (current.length + para.length + 1 > MAX_CHUNK_CHARS) {
      flush()
    }
    current = current ? `${current}\n${para}` : para
  }
  flush()

  // Prepend the title to the first chunk for better recall on heading terms.
  const heading = (title ?? '').trim()
  if (heading && chunks.length > 0) {
    chunks[0] = `${heading}\n${chunks[0]}`.slice(0, MAX_CHUNK_CHARS + heading.length + 1)
  } else if (heading && chunks.length === 0) {
    chunks.push(heading)
  }

  return chunks
}

export async function POST(request: Request) {
  const gate = await requireCompanyAdmin()
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }

  // Embeddings must be configured for this endpoint to do anything meaningful.
  // Provider-agnostic now (OpenAI / NVIDIA / any OpenAI-compatible endpoint) —
  // see src/lib/embeddings.ts resolveEmbeddingConfig().
  if (!isEmbeddingEnabled()) {
    return NextResponse.json(
      { error: 'Embeddings are not configured (set an embedding provider, e.g. NVIDIA/OPENAI/EMBEDDINGS_* env).' },
      { status: 400 }
    )
  }

  // Resolve the target company. Non-super-admins are pinned to their own
  // company; a super_admin may pass ?company_id to reindex another tenant (and
  // MUST, since they have no company of their own to default to).
  const url = new URL(request.url)
  const requestedCompanyId = url.searchParams.get('company_id')
  let targetCompanyId: string | null
  if (gate.ctx.isSuperAdmin) {
    targetCompanyId = requestedCompanyId || gate.ctx.companyId
  } else {
    targetCompanyId = gate.ctx.companyId
  }

  if (!targetCompanyId) {
    return NextResponse.json(
      { error: 'No company in scope. Super admins must pass ?company_id.' },
      { status: 400 }
    )
  }

  try {
    const supabase = await createServiceRoleClient()

    // Active articles for the target company only (tenant scope on the
    // service-role client = this explicit company_id filter).
    const { data: articles, error: loadError } = await supabase
      .from('kb_articles')
      .select('id, company_id, title, content')
      .eq('company_id', targetCompanyId)
      .eq('is_active', true)

    if (loadError) {
      logError('ai', 'kb_reindex_load_failed', loadError.message, { company_id: targetCompanyId })
      return NextResponse.json({ error: 'Failed to load KB articles' }, { status: 500 })
    }

    const rows = (articles as KbArticleRow[] | null) ?? []
    let articlesIndexed = 0
    let chunksIndexed = 0

    for (const article of rows) {
      const chunks = chunkContent(article.title, article.content)
      if (chunks.length === 0) {
        // Nothing to embed — still clear any stale rows so a now-empty article
        // doesn't linger in the index.
        await supabase.from('kb_embeddings').delete().eq('kb_article_id', article.id)
        continue
      }

      // Embed all chunks for this article in one request. embedBatch never
      // throws; on failure every element is null and we skip the article.
      const vectors = await embedBatch(chunks)
      const insertRows = chunks
        .map((content, idx) => ({ content, vector: vectors[idx], chunk_index: idx }))
        .filter((r) => Array.isArray(r.vector))
        .map((r) => ({
          kb_article_id: article.id,
          company_id: targetCompanyId,
          chunk_index: r.chunk_index,
          content: r.content,
          embedding: r.vector as number[],
        }))

      if (insertRows.length === 0) {
        // Whole batch failed to embed — leave existing rows in place rather than
        // wiping a previously-good index on a transient OpenAI error.
        logError(
          'ai',
          'kb_reindex_article_embed_failed',
          'embedBatch returned no vectors',
          { company_id: targetCompanyId, kb_article_id: article.id }
        )
        continue
      }

      // Replace this article's rows: delete then insert (the article is the unit
      // of reindex; ON DELETE CASCADE also covers article deletion separately).
      const { error: delError } = await supabase
        .from('kb_embeddings')
        .delete()
        .eq('kb_article_id', article.id)
      if (delError) {
        logError('ai', 'kb_reindex_delete_failed', delError.message, {
          company_id: targetCompanyId,
          kb_article_id: article.id,
        })
        continue
      }

      const { error: insError } = await supabase.from('kb_embeddings').insert(insertRows)
      if (insError) {
        logError('ai', 'kb_reindex_insert_failed', insError.message, {
          company_id: targetCompanyId,
          kb_article_id: article.id,
        })
        continue
      }

      articlesIndexed += 1
      chunksIndexed += insertRows.length
    }

    logInfo('ai', 'kb_reindex_complete', 'KB reindex finished', {
      company_id: targetCompanyId,
      articles: articlesIndexed,
      chunks: chunksIndexed,
    })

    return NextResponse.json({ articles: articlesIndexed, chunks: chunksIndexed }, { status: 200 })
  } catch (err) {
    logError('ai', 'kb_reindex_error', err instanceof Error ? err.message : 'unknown error', {
      company_id: targetCompanyId,
    })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
