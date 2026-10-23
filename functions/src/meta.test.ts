import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { leadToSalesEvent, parseBoostRequest, parseEntityChange, summarizeInsights, verifyMetaSignature } from './meta';

const sign = (body: string, secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('verifyMetaSignature', () => {
  const body = '{"object":"page","entry":[]}';

  it('accepts a body signed with the app secret', () => {
    expect(verifyMetaSignature(Buffer.from(body), sign(body, 's3cret'), 's3cret')).toBe(true);
  });

  it('rejects a tampered body, a wrong secret and a missing header', () => {
    expect(verifyMetaSignature(Buffer.from(body + ' '), sign(body, 's3cret'), 's3cret')).toBe(false);
    expect(verifyMetaSignature(Buffer.from(body), sign(body, 'other'), 's3cret')).toBe(false);
    expect(verifyMetaSignature(Buffer.from(body), undefined, 's3cret')).toBe(false);
    expect(verifyMetaSignature(Buffer.from(body), 'sha256=abc', 's3cret')).toBe(false);
  });
});

describe('leadToSalesEvent', () => {
  it('maps an Instagram lead onto the website form shape', () => {
    const event = leadToSalesEvent({
      id: '123',
      created_time: '2026-10-03T05:00:00+0000',
      platform: 'ig',
      campaign_name: 'Indore principals',
      form_id: '987',
      field_data: [
        { name: 'full_name', values: ['Asha Rao'] },
        { name: 'school_name', values: ['ZZ Test School'] },
        { name: 'email', values: ['asha@example.com'] },
        { name: 'phone_number', values: ['+919800000000'] },
        { name: 'city', values: ['Indore'] },
        { name: 'job_title', values: ['Principal'] },
      ],
    });
    expect(event).toMatchObject({
      type: 'meta_lead',
      leadgenId: '123',
      name: 'Asha Rao',
      organization: 'ZZ Test School',
      email: 'asha@example.com',
      phone: '+919800000000',
      role: 'Principal',
      source: 'instagram_lead_ad',
      utmSource: 'instagram',
      utmCampaign: 'Indore principals',
      formId: '987',
      submittedAt: '2026-10-03T05:00:00.000Z',
    });
    expect(event.message).toContain('city: Indore');
  });

  it('treats non-Instagram leads as Facebook', () => {
    expect(leadToSalesEvent({ platform: 'fb', field_data: [] }).source).toBe('facebook_lead_ad');
  });
});

describe('budget guards', () => {
  it('caps entity budget changes at the daily limit', () => {
    expect(parseEntityChange({ dailyBudget: 500 })).toEqual({ dailyBudget: 500 });
    expect(parseEntityChange({ dailyBudget: 999999 })).toMatch(/limit/);
    expect(parseEntityChange({ status: 'DELETED' })).toMatch(/ACTIVE or PAUSED/);
    expect(parseEntityChange({})).toMatch(/Nothing/);
  });

  it('validates boost requests', () => {
    expect(parseBoostRequest({ igMediaId: '17895000000000001', dailyBudget: 500, days: 7, cities: ['Indore'] })).toMatchObject({
      goal: 'visits',
      dailyBudget: 500,
      days: 7,
      cities: ['Indore'],
      ageMin: 25,
    });
    expect(parseBoostRequest({ igMediaId: 'x', dailyBudget: 500, days: 7 })).toMatch(/post/);
    expect(parseBoostRequest({ igMediaId: '17895000000000001', dailyBudget: 50, days: 7 })).toMatch(/₹100/);
    expect(parseBoostRequest({ igMediaId: '17895000000000001', dailyBudget: 500, days: 60 })).toMatch(/30 days/);
  });
});

describe('summarizeInsights', () => {
  it('counts leads once even when Meta reports overlapping lead actions', () => {
    const s = summarizeInsights({
      spend: '1000',
      clicks: '40',
      actions: [
        { action_type: 'lead', value: '4' },
        { action_type: 'onsite_conversion.lead_grouped', value: '4' },
        { action_type: 'link_click', value: '40' },
      ],
    });
    expect(s).toMatchObject({ spend: 1000, clicks: 40, leads: 4, costPerLead: 250 });
    expect(summarizeInsights(undefined).costPerLead).toBeNull();
  });
});
