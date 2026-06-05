import { describe, it, expect } from 'vitest'
import { firstMissingConfigField, REQUIRED_CONFIG_FIELDS } from '@/lib/channel-config'

describe('channel config required-field validation', () => {
  // Regression guard: these are the exact required fields the POST route used to
  // check inline per channel.
  it('declares the required fields per channel', () => {
    expect(REQUIRED_CONFIG_FIELDS.email).toEqual(['smtp_host', 'smtp_user', 'smtp_password'])
    expect(REQUIRED_CONFIG_FIELDS.teams).toEqual(['azure_tenant_id', 'azure_client_id', 'azure_client_secret'])
    expect(REQUIRED_CONFIG_FIELDS.whatsapp).toEqual(['phone_number_id', 'access_token'])
    expect(REQUIRED_CONFIG_FIELDS.sms).toEqual(['account_sid', 'auth_token', 'from_number'])
    expect(REQUIRED_CONFIG_FIELDS.telegram).toEqual(['bot_token'])
    expect(REQUIRED_CONFIG_FIELDS.messenger).toEqual(['page_id', 'page_access_token'])
    expect(REQUIRED_CONFIG_FIELDS.instagram).toEqual(['page_id', 'page_access_token'])
  })

  it('detects missing SMS (Twilio) fields in order', () => {
    expect(firstMissingConfigField('sms', {})).toBe('account_sid')
    expect(firstMissingConfigField('sms', { account_sid: 'AC1', auth_token: 't' })).toBe('from_number')
    expect(
      firstMissingConfigField('sms', { account_sid: 'AC1', auth_token: 't', from_number: '+1' })
    ).toBeNull()
  })

  it('returns the first missing field, or null when all present', () => {
    expect(firstMissingConfigField('email', {})).toBe('smtp_host')
    expect(firstMissingConfigField('email', { smtp_host: 'h' })).toBe('smtp_user')
    expect(
      firstMissingConfigField('email', { smtp_host: 'h', smtp_user: 'u', smtp_password: 'p' })
    ).toBeNull()
    expect(firstMissingConfigField('teams', { azure_tenant_id: 't', azure_client_id: 'c' })).toBe(
      'azure_client_secret'
    )
    expect(
      firstMissingConfigField('whatsapp', { phone_number_id: 'p', access_token: 't' })
    ).toBeNull()
  })

  it('treats empty string / falsy values as missing (matches the prior inline check)', () => {
    expect(firstMissingConfigField('whatsapp', { phone_number_id: '', access_token: 't' })).toBe(
      'phone_number_id'
    )
    expect(firstMissingConfigField('email', { smtp_host: 'h', smtp_user: 'u', smtp_password: '' })).toBe(
      'smtp_password'
    )
  })
})
