import type { Metadata } from 'next'
import { LegalPage, type LegalSection } from '@/components/marketing/legal'
import { SITE_NAME, CONTACT_EMAIL } from '@/lib/site'

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: `How ${SITE_NAME} collects, uses and protects personal information and customer communications data.`,
  alternates: { canonical: '/privacy' },
  robots: { index: true, follow: true },
}

const sections: LegalSection[] = [
  {
    heading: 'Overview',
    paragraphs: [
      `${SITE_NAME} (“Unified”, “we”, “us”) provides a multi-channel, multi-tenant communication workspace. This Privacy Policy explains what information we handle and how we protect it. It applies to our marketing website and to the Unified application.`,
      'Where we process customer communications (such as emails, messages and contacts) on behalf of a customer using Unified, that customer is the controller of the data and we act as a processor under their instructions.',
    ],
  },
  {
    heading: 'Information we collect',
    bullets: [
      'Account information: name, work email, company and role, used to create and secure your workspace.',
      'Customer communications data: the email, Teams, WhatsApp, SMS, Telegram, Messenger, Instagram and website live-chat messages, attachments and contact details that flow through the inbox you connect.',
      'Usage data: log and diagnostic information such as request identifiers, timestamps and feature usage, used to operate and improve the service.',
      'Cookies: strictly necessary cookies for authentication and session management.',
    ],
  },
  {
    heading: 'How we use information',
    bullets: [
      'To provide, maintain and secure the Unified service.',
      'To route, thread, de-duplicate and display your conversations.',
      'To generate AI-drafted replies that your team reviews before sending.',
      'To measure service quality (SLA timers, CSAT) within your workspace.',
      'To communicate with you about your account, security and support.',
    ],
  },
  {
    heading: 'Multi-tenant data isolation',
    paragraphs: [
      'Unified is multi-tenant by design. Each customer (company) is a separate tenant, and data is isolated at the database layer using row-level security so that one tenant cannot access another tenant’s information. Access within a tenant is further controlled by role-based permissions.',
    ],
  },
  {
    heading: 'Sharing and subprocessors',
    paragraphs: [
      'We do not sell personal information. We share data only with infrastructure and AI subprocessors that help us run the service (for example, cloud hosting, database, and the AI model provider used to generate reply drafts), under contractual confidentiality and security obligations, and only as needed to deliver Unified.',
    ],
  },
  {
    heading: 'Data retention',
    paragraphs: [
      'We retain account and communications data for as long as your workspace is active or as needed to provide the service, and thereafter as required to comply with legal obligations, resolve disputes and enforce agreements. Customers can request deletion of their workspace data as described below.',
    ],
  },
  {
    heading: 'Security',
    bullets: [
      'Encryption of data in transit.',
      'Tenant-level isolation enforced in the database (row-level security).',
      'Role-based access control and least-privilege service credentials.',
      'Audit trails and per-request tracing for accountability.',
    ],
  },
  {
    heading: 'Your rights',
    paragraphs: [
      'Depending on your location, you may have rights to access, correct, export or delete personal information, and to object to or restrict certain processing. To exercise these rights, contact us using the details below. If we process data on behalf of a customer, we will refer your request to that customer.',
    ],
  },
  {
    heading: 'International transfers',
    paragraphs: [
      'Your information may be processed in countries other than your own. Where required, we use appropriate safeguards for international transfers consistent with applicable law.',
    ],
  },
  {
    heading: 'Children’s privacy',
    paragraphs: [
      'Unified is a business product and is not directed to children. We do not knowingly collect personal information from children.',
    ],
  },
  {
    heading: 'Changes to this policy',
    paragraphs: [
      'We may update this Privacy Policy from time to time. We will post the updated version here and revise the “Last updated” date above.',
    ],
  },
  {
    heading: 'Contact us',
    paragraphs: [
      `Questions about this policy or your data? Email us at ${CONTACT_EMAIL}.`,
    ],
  },
]

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      updated="May 30, 2026"
      intro="Your trust matters. This policy describes the information Unified handles and the measures we take to keep it private and secure."
      sections={sections}
    />
  )
}
