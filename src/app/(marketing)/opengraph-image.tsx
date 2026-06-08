import { ImageResponse } from 'next/og'
import { SITE_URL } from '@/lib/site'

export const alt = 'Unified Communication Portal — One AI inbox for every channel'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

/**
 * Branded social-share card, generated on demand. Pure inline styles (Satori),
 * no external fonts or images, so it never blocks the build.
 */
export default function OpengraphImage() {
  const host = SITE_URL.replace(/^https?:\/\//, '')
  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          height: '100%',
          padding: '72px',
          justifyContent: 'space-between',
          background: 'linear-gradient(135deg, #115e59 0%, #0f766e 45%, #047857 100%)',
          color: 'white',
          fontFamily: 'sans-serif',
        }}
      >
        {/* brand row */}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 72,
              height: 72,
              borderRadius: 20,
              background: 'rgba(255,255,255,0.16)',
              border: '2px solid rgba(255,255,255,0.35)',
            }}
          >
            <div style={{ display: 'flex', width: 34, height: 26, borderRadius: 10, background: 'white' }} />
          </div>
          <div style={{ display: 'flex', marginLeft: 24, fontSize: 34, fontWeight: 700 }}>Unified</div>
        </div>

        {/* headline */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', fontSize: 68, fontWeight: 800, lineHeight: 1.1, maxWidth: 920 }}>
            Every customer conversation. One intelligent inbox.
          </div>
          <div style={{ display: 'flex', marginTop: 24, fontSize: 30, color: 'rgba(255,255,255,0.85)', maxWidth: 880 }}>
            AI-powered shared inbox for email, chat, SMS &amp; social — 8 channels in one.
          </div>
        </div>

        {/* footer row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 14 }}>
            {['Email', 'WhatsApp', 'Teams', 'SMS', 'Instagram', 'Live Chat'].map((c) => (
              <div
                key={c}
                style={{
                  display: 'flex',
                  padding: '10px 22px',
                  borderRadius: 999,
                  background: 'rgba(255,255,255,0.15)',
                  border: '1px solid rgba(255,255,255,0.3)',
                  fontSize: 24,
                  fontWeight: 600,
                }}
              >
                {c}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', fontSize: 26, color: 'rgba(255,255,255,0.8)' }}>{host}</div>
        </div>
      </div>
    ),
    { ...size },
  )
}
