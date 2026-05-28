-- Phase 4: Company logos Supabase Storage bucket.
--
-- Provisions a public, MIME-restricted, size-capped storage bucket that the
-- /api/admin/companies/[id]/logo endpoint writes to. The bucket is public so
-- the <img src> rendered in dashboard / inbox / signature templates does not
-- need signed-URL fetches per render.
--
-- Writes are super_admin only — a malicious tenant_admin should not be able
-- to overwrite another tenant's logo by guessing a path, and Storage RLS is
-- the only thing standing between an authenticated user and the bucket
-- (the bucket itself is `public=true`, which only governs READ).

-- =========================================================================
-- Part 1: bucket row
-- =========================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'company-logos',
  'company-logos',
  true,                            -- public read (so <img src> works without signed URLs)
  524288,                          -- 512 KB cap (matches API-level validation)
  ARRAY['image/png','image/jpeg','image/jpg','image/webp','image/svg+xml']
) ON CONFLICT (id) DO UPDATE SET
  file_size_limit    = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types,
  public             = EXCLUDED.public;

-- =========================================================================
-- Part 2: RLS policies on storage.objects (scoped to company-logos)
-- =========================================================================
--
-- RLS on storage.objects is enabled by Supabase by default. We just add
-- our bucket-specific policies. Each policy is dropped first so the
-- migration is re-runnable on environments where it has already been
-- applied (storage policies are not IF NOT EXISTS friendly).

DROP POLICY IF EXISTS "Anyone can read company-logos"      ON storage.objects;
DROP POLICY IF EXISTS "Super admins write company-logos"   ON storage.objects;
DROP POLICY IF EXISTS "Super admins update company-logos"  ON storage.objects;
DROP POLICY IF EXISTS "Super admins delete company-logos"  ON storage.objects;

-- Public read. Bucket is public=true so this is mostly explicit
-- documentation, but it ensures we don't get caught out if someone
-- flips `public` to false later.
CREATE POLICY "Anyone can read company-logos"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'company-logos');

-- Writes locked to super_admin. The API route uses the service-role key
-- (which bypasses RLS), so these policies only matter if someone were
-- to talk to storage with an end-user JWT — defense in depth.
CREATE POLICY "Super admins write company-logos"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'company-logos' AND public.is_super_admin());

CREATE POLICY "Super admins update company-logos"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'company-logos' AND public.is_super_admin());

CREATE POLICY "Super admins delete company-logos"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'company-logos' AND public.is_super_admin());
