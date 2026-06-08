import type { Metadata } from 'next'
import { LegalPage, type LegalSection } from '@/components/marketing/legal'
import { SITE_NAME, CONTACT_EMAIL } from '@/lib/site'

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: `The terms governing access to and use of the ${SITE_NAME} service.`,
  alternates: { canonical: '/terms' },
  robots: { index: true, follow: true },
}

const sections: LegalSection[] = [
  {
    heading: 'Agreement to terms',
    paragraphs: [
      `These Terms of Service (“Terms”) govern your access to and use of ${SITE_NAME} (“Unified”, the “Service”). By accessing or using the Service, you agree to these Terms. If you are using the Service on behalf of an organization, you agree on its behalf.`,
    ],
  },
  {
    heading: 'The service',
    paragraphs: [
      'Unified is a multi-channel, multi-tenant communication workspace that brings email, Microsoft Teams, WhatsApp, SMS, Telegram, Facebook Messenger, Instagram and an embeddable website live-chat widget into a single inbox, with collaboration, automation and AI-assisted reply drafting. Access is currently invite-only and provisioned by us.',
    ],
  },
  {
    heading: 'Accounts and eligibility',
    bullets: [
      'You must provide accurate account information and keep your credentials secure.',
      'You are responsible for activity under your account and for your users’ compliance with these Terms.',
      'You must be authorized to use the channels and data you connect to Unified.',
    ],
  },
  {
    heading: 'Acceptable use',
    paragraphs: ['You agree not to:'],
    bullets: [
      'Use the Service for unlawful, harmful, or abusive purposes, including sending spam.',
      'Attempt to access another tenant’s data or to circumvent security or access controls.',
      'Reverse engineer, disrupt, or overload the Service or its infrastructure.',
      'Upload malware or content that infringes the rights of others.',
    ],
  },
  {
    heading: 'Customer data and ownership',
    paragraphs: [
      'As between the parties, you retain all rights to the communications and data you process through Unified (“Customer Data”). You grant us the limited rights necessary to host, process and display Customer Data to provide the Service. We process Customer Data in accordance with our Privacy Policy.',
    ],
  },
  {
    heading: 'AI features',
    paragraphs: [
      'Unified can generate AI-drafted replies to assist your team. AI drafts require human review and approval before sending — the Service does not send AI-generated messages automatically. AI output may be inaccurate or incomplete; you are responsible for reviewing it before use.',
    ],
  },
  {
    heading: 'Fees',
    paragraphs: [
      'Fees for the Service are agreed in a separate order or quote based on your seats, channels and brands. Unless stated otherwise, fees are non-refundable and exclusive of taxes.',
    ],
  },
  {
    heading: 'Confidentiality',
    paragraphs: [
      'Each party may receive confidential information from the other. The receiving party will protect it with reasonable care and use it only to fulfil its obligations under these Terms.',
    ],
  },
  {
    heading: 'Warranties and disclaimers',
    paragraphs: [
      'The Service is provided “as is” and “as available”. To the maximum extent permitted by law, we disclaim all warranties, express or implied, including merchantability, fitness for a particular purpose and non-infringement. We do not warrant that the Service will be uninterrupted or error-free.',
    ],
  },
  {
    heading: 'Limitation of liability',
    paragraphs: [
      'To the maximum extent permitted by law, neither party will be liable for indirect, incidental, special, consequential or punitive damages, or for lost profits or revenues. Our aggregate liability arising out of or related to the Service will not exceed the amounts you paid for the Service in the twelve months preceding the claim.',
    ],
  },
  {
    heading: 'Termination',
    paragraphs: [
      'You may stop using the Service at any time. We may suspend or terminate access for breach of these Terms or to protect the Service. Upon termination, your right to use the Service ends and we will make Customer Data available for export for a reasonable period as described in our policies.',
    ],
  },
  {
    heading: 'Changes to these terms',
    paragraphs: [
      'We may update these Terms from time to time. Material changes will be posted here with an updated “Last updated” date. Continued use of the Service after changes take effect constitutes acceptance.',
    ],
  },
  {
    heading: 'Governing law',
    paragraphs: [
      'These Terms are governed by the laws of the jurisdiction in which Unified is operated, without regard to conflict-of-laws principles. The courts of that jurisdiction will have exclusive jurisdiction over disputes, unless otherwise required by applicable law.',
    ],
  },
  {
    heading: 'Contact us',
    paragraphs: [`Questions about these Terms? Email us at ${CONTACT_EMAIL}.`],
  },
]

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      updated="May 30, 2026"
      intro="These terms set out the rules for using Unified. Please read them carefully."
      sections={sections}
    />
  )
}
