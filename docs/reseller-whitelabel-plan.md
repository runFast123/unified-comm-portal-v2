# White-Label & Reseller Capability — Architecture, Phasing & Cost Plan

**Status:** Proposal for review · **Date:** 2026-06-03 · **Owner:** Platform team

This document scopes turning the portal into a **white-label, reseller-ready SaaS** so the
platform can be sold *through partners* (resellers/agencies) who rebrand it and onboard their
own customers. It assesses what already exists, the target architecture, a de-risked phase
plan with effort estimates, a cost breakdown, and the business decisions required before build.

> **Headline:** The foundation is unusually well-suited to this. The three features originally
> asked about (white-label branding, custom domains, per-tenant SSO) are real but **mis-ranked**:
> the actual unlocks for *reselling* are a **reseller hierarchy** and a **billing/metering layer**,
> neither of which exists yet. Branding is half-scaffolded; AI cost-isolation is already solved.

---

## 1. Current state assessment

### Already built (accelerates this)
| Capability | Evidence | Why it matters for reselling |
|---|---|---|
| **Tenant isolation** | RLS (`company_id = current_user_company_id()`), TS-scoped service routes, cross-tenant tripwire test | The hard security foundation a reseller's customers depend on — already solid. |
| **Branding fields** | `companies.slug`, `logo_url`, `accent_color`, `default_email_signature`, `settings` jsonb | White-label is **partially scaffolded** — the data layer exists; the UI just needs to *apply* it everywhere. |
| **AI cost isolation** | Per-tenant AI provider keys, `companies.monthly_ai_budget_usd`, `lib/ai-usage.ts` usage tracking | The #1 thing platforms struggle to resell. Customers' AI spend doesn't all land on you — each tenant BYO-keys or is budget-capped. **Major head start.** |
| **Role hierarchy** | `super_admin ⊃ company_admin ⊃ supervisor ⊃ company_member` | Extensible — add one `reseller_admin` tier between super_admin and company_admin. |
| **Clean tenant model** | `company = tenant`, single DB, pooled/RLS | Industry-standard multi-tenancy; the right base to layer a reseller tier onto. |

### Missing (the real work)
| Gap | Impact | Phase |
|---|---|---|
| **Reseller hierarchy** | No partner tier → *you* hand-create every tenant. No self-serve resale. | 2 (core) |
| **Billing / metering** | AI *usage* is tracked but there's **no Stripe / subscriptions / invoicing**. Can't monetize resale. | 3 (core) |
| **Host → tenant routing** | No subdomain/custom-domain resolution in middleware (tenant comes from session only). | 2 / 4 |
| **Custom domains + TLS automation** | No per-customer domain onboarding. | 4 |
| **Per-tenant SSO/SAML** | No enterprise IdP login. | 5 (defer) |

---

## 2. Target architecture

### 2.1 Three-tier tenancy
```
Platform (you, super_admin)
   └── Reseller / Partner            ← NEW tier (reseller_admin)
          └── Company (tenant)        ← today's "company"
                 └── Users / Accounts ← unchanged
```
A **Reseller** owns a set of Companies. A `reseller_admin` is effectively a *super_admin bounded
to their own downstream* — they can create/manage companies, users, and branding **only** under
their reseller, never across the platform.

### 2.2 Data-model changes
- **`resellers`** (new): `id`, `name`, `slug`, branding (`logo_url`, `accent_color`, `product_name`,
  `support_email`, `from_email`), billing (`stripe_customer_id`, `plan`, `status`), `created_at`.
- **`companies.reseller_id uuid references resellers(id)`** — nullable; `null` = platform-direct tenant.
- **`users.reseller_id uuid`** — nullable; set (with `company_id` null) for a `reseller_admin` who spans
  all companies under that reseller.
- **`domains`** (new): `host text unique`, `reseller_id`/`company_id`, `verified_at`, `tls_status` —
  maps custom domains & subdomains to a reseller or company.
- **Role enum**: add `reseller_admin`.

### 2.3 RLS / scoping changes (the security-critical part)
- New SECURITY DEFINER helper `current_user_reseller_id()` (mirrors `current_user_company_id()`).
- Extend tenant policies so a `reseller_admin` may access rows where the owning company's
  `reseller_id = current_user_reseller_id()`. Pattern:
  `is_super_admin() OR company_id = current_user_company_id() OR company_id IN (SELECT id FROM companies WHERE reseller_id = current_user_reseller_id())`.
- Update `lib/tenant-guard.ts` with a `requireResellerAdmin()` + reseller-scoped account/company helpers.
- **Extend the cross-tenant tripwire** to also assert reseller-scoping signals — so the new tier
  can't accidentally leak across resellers (same discipline that just caught `get_dashboard_kpis`).

### 2.4 Tenant resolution (host → tenant)
Middleware maps the request host to a reseller/company **as a branding + routing hint only**:
- `acme.yourapp.com` → company `acme`; `partnerco.yourapp.com` → reseller console.
- custom domain (`support.acmeclient.com`) → `domains` lookup.
- **Security invariant:** the host-derived tenant is *always* re-validated against the user's real
  membership. The host selects branding and a default workspace; it never grants access.

### 2.5 Branding resolution
Resolve at request time, **company → reseller → platform default** precedence. Apply via CSS
variables (`accent_color`), `logo_url`, `product_name` in `<head>`/metadata, and templated emails
(invite, CSAT, notifications). Most of the per-company fields already exist.

### 2.6 Billing model (decision required — see §5)
- **Option A — bill resellers only (B2B2B):** you charge each reseller a subscription + metered
  usage; resellers bill their own customers off-platform. **Simplest; recommended to start.**
- **Option B — bill end-customers via Stripe Connect (revenue share):** platform collects, splits
  with reseller. Powerful but materially more complex (KYC, payouts, tax).
- Metering: extend the existing usage tracking into a billing-grade `usage_events` + monthly
  rollup per company → per reseller → Stripe subscription items.

---

## 3. Phase plan (value-first, de-risked)

> Estimates assume **one experienced full-stack dev**; ranges reflect unknowns. They are planning
> figures, not commitments.

### Phase 1 — White-label branding · **~1–2 weeks**
- **Goal:** any tenant/reseller portal shows *their* logo, color, product name — no platform brand.
- **Scope:** branding resolver (CSS vars + metadata); apply to dashboard, `login`, `accept-invite`,
  marketing-less auth shell, and email templates; branding settings page (logo upload to Supabase
  Storage, color picker, product name, support/from email).
- **Schema:** extend `companies`/`resellers` branding columns (most exist); add `product_name`,
  `support_email`, `from_email` if missing.
- **Done when:** a tenant on a subdomain sees fully rebranded UI + emails.
- **Risk:** low. Mostly UI + asset handling.

### Phase 2 — Reseller hierarchy + subdomain routing · **~3–5 weeks** *(core enabler)*
- **Goal:** partners self-serve — create/manage their own companies & users under their brand.
- **Scope:** `resellers` table, `companies.reseller_id`, `users.reseller_id`, `reseller_admin` role;
  RLS helpers + policy updates + tripwire extension; host→tenant middleware (subdomains);
  reseller console (manage companies, invite users, set branding, view usage).
- **Done when:** a reseller_admin logs into `partner.yourapp.com`, creates a company, invites a
  user, and **cannot** see any other reseller's data (verified by tests).
- **Risk:** medium-high — RLS + role changes touch every scoped route. Heavy test coverage required.

### Phase 3 — Billing & metering · **~4–8 weeks** *(core monetization)*
- **Goal:** charge resellers (and optionally their customers) automatically.
- **Scope:** Stripe integration (customers, subscriptions, webhooks); `usage_events` + monthly
  rollup per company/reseller; plan/entitlement gating (seats, message volume, AI budget);
  reseller billing dashboard + invoices.
- **Done when:** a reseller's subscription + usage produces a correct Stripe invoice end-to-end.
- **Risk:** high — billing is always deep (proration, dunning, tax, edge cases). Scope tightly to
  the chosen model (§2.6 / §5).

### Phase 4 — Custom domains · **~2–3 weeks**
- **Goal:** `support.acmeclient.com` → their portal with auto-TLS.
- **Scope:** Vercel Domains API integration (add domain, poll verification, issue cert); `domains`
  table; verification UX (CNAME/TXT); host→tenant for custom domains.
- **Done when:** a reseller adds a domain, verifies it, and it serves their branded portal over HTTPS.
- **Risk:** medium — TLS/verification automation + Vercel limits/pricing at scale.

### Phase 5 — Per-tenant SSO/SAML · **~2–3 weeks (per pattern)** *(defer until a deal needs it)*
- **Goal:** enterprise end-customers log in with their own IdP (Okta/Azure AD/Google Workspace).
- **Scope:** Supabase SSO provider config per customer domain; domain→IdP routing on login; JIT
  user provisioning into the right company.
- **Done when:** a user at `@enterprise.com` is redirected to their IdP and lands in their company.
- **Risk:** medium; mostly config + provisioning glue. Build on first enterprise demand.

**MVP to a sellable reseller product = Phases 1–3 (~2.5–3.5 months).** Phases 4–5 are
revenue-expanders added on demand.

---

## 4. Cost breakdown (ballpark — **verify current pricing before committing**)

### One-time (engineering)
| Item | Estimate |
|---|---|
| Phases 1–3 (MVP) | ~10–15 dev-weeks |
| Phases 4–5 (expansion) | ~4–6 dev-weeks |

### Ongoing (infra/SaaS)
| Service | Role | Rough cost | Notes |
|---|---|---|---|
| **Vercel** | Hosting + custom domains | Pro ~$20/seat/mo; domains at scale may need higher tier | Confirm per-domain limits/cost for many customer domains. |
| **Supabase** | DB + Auth (+ SSO) | Pro from ~$25/mo + usage | SSO/SAML requires Pro+; scales with compute/storage/egress. |
| **Stripe** | Billing | ~2.9% + 30¢ per charge | Connect (Option B) adds payout/KYC fees. |
| **AI providers** | LLM inference | Pass-through | Per-tenant keys/budgets → your cost stays bounded. **Already handled.** |
| **Storage/CDN** | Branding assets | Negligible at start | Supabase Storage. |

> Numbers are indicative for planning. Re-check Vercel/Supabase/Stripe pricing at decision time —
> custom-domains-at-scale and SSO are the two line items most likely to change the math.

---

## 5. Business decisions required before build
1. **Billing model:** Option A (bill resellers only) or Option B (Stripe Connect revenue share)? *Recommend A first.*
2. **End-customer ownership:** who owns support & the relationship — you or the reseller? Drives reseller-console scope.
3. **Pricing to resellers:** flat / per-seat / per-tenant / usage-based? Drives metering design.
4. **Multi-tenant users:** keep one-tenant-per-user (current) — or allow a user across tenants? *Recommend keep single; only `reseller_admin` spans many.*
5. **Domains:** subdomains-first (recommended) then custom domains, confirmed?
6. **Isolation ceiling:** pooled/RLS is fine for SMB resale; if a reseller's enterprise customer demands data residency, that's a future silo/region decision to acknowledge now.

---

## 6. Security & multi-tenant notes
- The pooled model's isolation is only as strong as its discipline — a single unscoped query
  leaks (cf. the `get_dashboard_kpis` fix). Reselling **multiplies** that surface, so:
  - Keep **RLS as the backstop** on every table (not just TS scoping) — defense in depth.
  - **Extend the tripwire** to assert reseller-scoping, and add reseller-isolation tests.
  - Add **per-tenant data export/delete** (GDPR) before onboarding paying partners.
- Host-derived tenancy is a **branding/routing hint, never auth** — always re-validate against the
  user's real membership (subdomain/custom-domain can be spoofed).

---

## 7. Recommended sequence
1. **Phase 1 (branding)** — fast, visible, low-risk; proves the white-label story.
2. **Phase 2 (reseller tier + subdomains)** — the actual reselling unlock.
3. **Phase 3 (billing)** — monetize; scope to the chosen model.
4. **Phase 4 (custom domains)** / **Phase 5 (SSO)** — add on demand as deals require.

*Next step after review: lock the §5 decisions, then I can produce a detailed Phase 1 build spec
(schema diffs, file-by-file changes, test plan) and begin.*
