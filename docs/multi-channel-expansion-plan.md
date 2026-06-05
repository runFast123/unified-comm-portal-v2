# Multi-Channel Expansion — Architecture & Rollout Plan

**Status:** Proposal for review · **Date:** 2026-06-05 · **Owner:** Platform team

Goal: grow beyond the current 3 channels (Email/SMTP+IMAP, Microsoft Teams, WhatsApp)
to a true omnichannel inbox — **without** the per-channel code sprawl multiplying every
time. This documents the current (hardcoded) architecture, a channel-**adapter**
abstraction to replace it, a phased rollout of new channels, and the per-channel
onboarding hurdles + effort.

> **Headline:** Adding channels is the right move and fits the white-label/reseller
> direction (different tenants want different channel mixes). But channels are currently
> **hardcoded across ~25–30 files** (a TS union + a Postgres enum + per-channel
> webhooks/senders/pollers/UI). Adding the 4th–8th channel that way is unmaintainable.
> **Refactor to a channel-adapter registry first**, then each new channel is ~1 adapter
> file instead of a 25-file change.

---

## 1. Current state — channels are hardcoded, not registry-driven

A channel is woven through the codebase as the literal strings `'email' | 'teams' |
'whatsapp'`. To add one today you touch, at minimum:

| Layer | Where | Per-channel work today |
|---|---|---|
| **Type** | `src/types/database.ts` — `type ChannelType = 'teams'\|'email'\|'whatsapp'` (used in ~8 types) | extend the union |
| **DB** | Postgres `channel` **enum** + `src/lib/schema.sql` | enum-value migration |
| **Inbound** | `src/app/api/webhooks/{email,teams,whatsapp}/route.ts` + pollers (`email-poller`, `teams-poller`) | a new webhook route and/or poller |
| **Outbound** | `src/lib/channel-sender.ts` (`sendEmail`, `sendTeams`, …) + `src/app/api/send/route.ts` | a new `send*` fn + dispatch branch |
| **Credentials** | `src/lib/channel-config.ts`, `api/channels/config`, `api/channels/test` | a new config shape + test path |
| **UI — config** | `admin/channels/page.tsx` (per-channel cards + "Add Account" modals) | a new card + modal |
| **UI — display** | `components/ui/channel-icon.tsx`, `channel-filter.tsx`, `inbox/*` rows/preview, `conversation-thread.tsx` (per-channel message bubble) | icon, filter option, render branch |
| **Logic** | `routing-engine.ts`, `notification-service.ts`, `api/classify`, `api/ai-reply`, `api/scheduled-messages`, `inbox/facets` | channel-aware branches |
| **Marketing** | `(marketing)/*`, `site.ts` (copy lists "Email · Teams · WhatsApp") | copy update (trivial) |

**Net: ~25–30 code touchpoints per new channel**, several of which are near-duplicates of
the WhatsApp/Teams handlers. This is the thing to fix before scaling.

---

## 2. Target architecture — a channel-adapter registry

Define one interface; implement it once per channel; register it in one place. Everything
else (inbox, routing, AI, rendering) talks to the registry, not to literal channel names.

```ts
// src/lib/channels/types.ts
export interface NormalizedInbound {
  externalId: string            // provider message id (dedup)
  participant: { name?: string; email?: string; phone?: string; handle?: string }
  text: string
  attachments: Attachment[]
  threadKey?: string            // for grouping (email thread, chat id, …)
  sentAt?: string
}

export interface ChannelAdapter {
  key: string                   // 'sms' | 'telegram' | 'instagram' | …
  label: string                 // "SMS (Twilio)"
  icon: LucideIcon
  capabilities: { attachments: boolean; outbound: boolean; threading: boolean }
  configSchema: ZodSchema        // credentials shape (validated + encrypted)
  verifyWebhook?(req): boolean   // signature check (HMAC, etc.)
  parseInbound(payload): NormalizedInbound | NormalizedInbound[]
  send(account, message): Promise<SendResult>
  poll?(account): Promise<NormalizedInbound[]>   // for pull-based channels (IMAP)
}

// src/lib/channels/registry.ts
export const CHANNELS: Record<string, ChannelAdapter> = { email, teams, whatsapp, /* … */ }
```

Then:
- **One generic webhook** `api/webhooks/[channel]/route.ts` → looks up the adapter →
  `verifyWebhook` → `parseInbound` → existing ingest pipeline. (Keeps the per-channel
  routes only where a provider demands a fixed path.)
- **One generic send** path → `CHANNELS[channel].send(...)`.
- **DB:** switch `channel` from a Postgres **enum** to **`text`** validated against the
  registry — so a new channel needs **no migration**. (Keep a CHECK or trust the app.)
- **UI:** the channels page, icon, filter, and message renderer iterate `CHANNELS`
  instead of hardcoding three. New channel → appears automatically.

**Result:** a new channel = implement one `ChannelAdapter` + add it to the registry
(~1 file) + supply an icon. The ~25 touchpoints collapse to ~1.

---

## 3. Phased rollout

> Estimates assume one experienced full-stack dev. Ranges reflect provider-onboarding
> uncertainty, not code size.

### Phase 0 — Adapter refactor (no new channel yet) · **~2–3 weeks**
Introduce the registry + interface; migrate the **existing** email/teams/whatsapp logic
onto adapters; switch the `channel` column enum→text; make the inbox/icons/filters/
renderer iterate the registry. Ship behind the same behavior (pure refactor, regression-
guarded by the existing 950+ tests + new adapter unit tests). **This is the enabler — do
it first.**

### Phase 1 — SMS (Twilio) · **~1 week** *(highest ROI, easy onboarding)*
Inbound webhook (Twilio posts form-encoded), outbound via Twilio REST, HMAC signature
verify, phone as the participant key. No app-review gate. **Best first proof of the
adapter pattern + immediate value.**

### Phase 2 — Meta cluster: Instagram DM + Facebook Messenger · **~2–3 weeks**
Both ride the **Graph API / Meta webhook** you already use for WhatsApp, so they share
verification (`X-Hub-Signature-256`), the page/IG access-token model, and attachment
handling — cheap to add **together**. Gated by **Meta app review** (the real timeline
risk, not the code).

### Phase 3 — Telegram · **~3–5 days**
Bot API: trivial inbound webhook + `sendMessage`. No approval. Great low-effort breadth.

### Phase 4 — Slack · **~1–1.5 weeks**
Events API + Web API; OAuth per workspace. Strong for B2B/internal support.

### Phase 5 — Embeddable live-chat widget · **~2–3 weeks**
A small JS snippet customers embed on their site + a websocket/poll inbound + outbound.
Highest-conversion for sales, but it's a mini-product (widget + realtime), so it's last.

**MVP omnichannel = Phase 0 + SMS + Telegram (~4 weeks).** The Meta cluster, Slack, and
live-chat layer on after, each as an adapter.

---

## 4. Per-channel cheat-sheet

| Channel | Inbound | Outbound | Auth / creds | Onboarding hurdle | Effort |
|---|---|---|---|---|---|
| **SMS (Twilio)** | webhook (form-encoded) | Twilio REST | Account SID + auth token, signature | none | ~1 wk |
| **Instagram DM** | Meta webhook (shared) | Graph API | IG-linked Page token | **Meta app review** | shared |
| **Messenger** | Meta webhook (shared) | Graph API | Page token | **Meta app review** | ~2–3 wk together |
| **Telegram** | Bot webhook | `sendMessage` | Bot token (BotFather) | none | ~3–5 d |
| **Slack** | Events API | Web API | OAuth per workspace | Slack app config | ~1–1.5 wk |
| **Live chat** | widget → ws/poll | ws/poll | site key | build the widget | ~2–3 wk |

Others to consider later: **LINE / Viber** (regional), **Discord** (communities),
**Google Business Messages**, **Apple Messages for Business** (heavy approval).

---

## 5. The fiddly bits (don't under-budget these)
- **Attachment + formatting normalization** — every provider models media/markup
  differently; the adapter's job is to flatten it to your `Attachment` + text shape.
- **Threading/grouping** — email uses RFC headers; chat channels use a chat/conversation
  id; SMS groups by phone. The adapter supplies a `threadKey`.
- **Per-channel rate limits + retries** — fold into the existing send/retry plumbing.
- **Provider approval timelines** — Meta/WhatsApp/Apple gate launch on review; Twilio/
  Telegram/Slack don't. Sequence the easy ones first to ship value while reviews pend.

---

## 6. Decisions required before build
1. **Refactor-first vs. add-one-now?** Strong recommendation: **Phase 0 refactor first**
   (otherwise channels 4–8 each cost ~25 files). Confirm.
2. **`channel` enum → text?** Needed to avoid a migration per channel. Confirm (low risk;
   the registry validates values).
3. **Which channels, in what order?** Default: SMS → Telegram → Meta cluster → Slack →
   live chat. Adjust to your market.
4. **Per-tenant channel availability?** Tie into the reseller plan — should every tenant
   get every channel, or is channel access part of a plan/entitlement?

---

## 7. Recommended sequence
1. **Phase 0 — adapter refactor** (the enabler).
2. **SMS + Telegram** (fast, no approvals → ship omnichannel value immediately).
3. **Meta cluster** (start the app review early; it's the long pole).
4. **Slack**, then **live-chat widget**, as demand dictates.

*Next step after review: lock the §6 decisions, then I produce a detailed Phase 0 spec
(the `ChannelAdapter` interface, the registry, the enum→text migration, and a file-by-file
refactor map of the existing 3 channels) and begin.*
