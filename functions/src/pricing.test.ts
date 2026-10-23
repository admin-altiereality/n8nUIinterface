import { describe, expect, it } from 'vitest';
import { EMPTY_PRICING, agentPricingText, cleanPricing, pricingSheetRows, withPricingDefaults } from './pricing';

const plan = (over: Record<string, unknown> = {}) => ({
  name: 'Classroom-10',
  includes: '10 headsets, content, training',
  priceInr: 100000,
  priceMaxInr: 0,
  unit: 'one-time',
  agentCanShare: true,
  ...over,
});
const doc = (over: Record<string, unknown> = {}) => ({
  gstPercent: 18,
  plans: [plan()],
  partnerMargins: [{ label: 'Lab bundles', percent: 20 }],
  competitors: [{ name: 'Rival', offer: '10 headsets', price: '₹2,00,000', source: 'https://example.com', asOf: '2026-10' }],
  ...over,
});

describe('cleanPricing', () => {
  it('accepts a valid document and fills ids and defaults', () => {
    const p = cleanPricing(doc());
    expect(typeof p).not.toBe('string');
    if (typeof p === 'string') return;
    expect(p.plans[0]).toMatchObject({ id: 'classroom-10', notes: '', agentCanShare: true });
    expect(p.partnerMargins[0]).toEqual({ label: 'Lab bundles', percent: 20, notes: '' });
  });

  it('rejects bad prices, ranges, margins, links and duplicate ids', () => {
    expect(cleanPricing(doc({ plans: [plan({ priceInr: -1 })] }))).toMatch(/rupee amounts/);
    expect(cleanPricing(doc({ plans: [plan({ priceInr: 500, priceMaxInr: 100 })] }))).toMatch(/below its starting price/);
    expect(cleanPricing(doc({ plans: [plan(), plan()] }))).toMatch(/share the id/);
    expect(cleanPricing(doc({ partnerMargins: [{ label: 'x', percent: 90 }] }))).toMatch(/0–60%/);
    expect(cleanPricing(doc({ competitors: [{ name: 'Rival', source: 'javascript:alert(1)' }] }))).toMatch(/must be a link/);
    expect(cleanPricing(doc({ gstPercent: 99 }))).toMatch(/GST/);
    expect(cleanPricing([])).toMatch(/object/);
  });
});

describe('withPricingDefaults', () => {
  it('returns empty pricing for a missing or broken doc', () => {
    expect(withPricingDefaults(undefined)).toEqual(EMPTY_PRICING);
    expect(withPricingDefaults({ plans: 'x' })).toEqual(EMPTY_PRICING);
  });

  it('keeps the update stamp', () => {
    expect(withPricingDefaults({ ...doc(), updatedAt: '2026-10-20T10:00:00Z', updatedBy: 'a@b.c' }).updatedBy).toBe('a@b.c');
  });
});

describe('agentPricingText', () => {
  it('lists only shareable plans and never margins or competitors', () => {
    const p = withPricingDefaults(doc({ plans: [plan(), plan({ name: 'Secret', agentCanShare: false })] }));
    const text = agentPricingText(p);
    expect(text).toContain('Classroom-10: starting from ₹1,00,000 one-time, plus 18% GST');
    expect(text).not.toContain('Secret');
    expect(text).not.toContain('Rival');
    expect(text).not.toContain('20%');
  });

  it('tells the agent to defer when nothing is shareable', () => {
    expect(agentPricingText(EMPTY_PRICING)).toMatch(/No prices are approved/);
  });
});

describe('pricingSheetRows', () => {
  it('writes a header, every section and the GST line', () => {
    const rows = pricingSheetRows(withPricingDefaults(doc({ plans: [plan({ priceMaxInr: 150000 })] })));
    expect(rows[0][0]).toBe('Section');
    expect(rows[1]).toEqual(['Plan', 'Classroom-10', '₹1,00,000–₹1,50,000', 'one-time', '10 headsets, content, training', '', '']);
    expect(rows.map((r) => r[0])).toEqual(['Section', 'Plan', 'Partner margin', 'Competitor', '']);
  });
});
