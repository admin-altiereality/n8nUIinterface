import { describe, expect, it } from 'vitest';
import type { TwilioTemplate } from '../api/twilioClient';
import { arrangeTemplates, sentTemplates, suggestedKeys, templateRegex, templatesFor } from './waTemplates';

const t = (name: string, body = `Hi {{1}}, ${name}. — Team`): TwilioTemplate => ({ sid: `HX${name}`, name, channel: 'whatsapp', body });

const FORM_EN = t(
  'lxr_partner_form_en',
  'Hi {{1}}, thank you for your interest in becoming a LearnXR channel partner.\n\nSomeone from our team, {{2}}, will call you.\n\n— Team Altie Reality'
);
const FORM_HI = t('lxr_partner_form_hi', 'नमस्ते {{1}}, LearnXR चैनल पार्टनर बनने में आपकी रुचि के लिए धन्यवाद।\n\nहमारी टीम से {{2}} कॉल करेंगे।');
const PARTNER = [
  FORM_EN,
  FORM_HI,
  t('lxr_partner_book_call_en'),
  t('lxr_partner_step1_welcome_en'),
  t('lxr_partner_step2_product_kit_en'),
  t('lxr_partner_step2_product_kit_hi'),
  t('lxr_partner_step3_commercials_en'),
];
const SCHOOL = [
  t('lxr_school_step1_demo_recap_en'),
  t('lxr_school_step2_proposal_en'),
  t('lxr_school_reply_demo_en'),
  t('lxr_school_reply_positive_en'),
  t('lxr_school_reply_neutral_en'),
  t('positive_reply'),
];
const ALL = [...PARTNER, ...SCHOOL];
const lead = { stage: 'Engaged' as const, replyIntent: '' };

describe('templatesFor', () => {
  it('offers partners only partner templates and schools everything else', () => {
    expect(templatesFor(ALL, 'partner').every((x) => x.name.startsWith('lxr_partner_'))).toBe(true);
    expect(templatesFor(ALL, 'school').map((x) => x.name)).toEqual(SCHOOL.map((x) => x.name));
    expect(templatesFor(ALL, 'all')).toHaveLength(ALL.length);
  });
});

describe('templateRegex', () => {
  it('matches the sent text with the variables filled', () => {
    expect(templateRegex(FORM_EN.body!).test(FORM_EN.body!.replace('{{1}}', 'Gaurav').replace('{{2}}', 'Asha'))).toBe(true);
    expect(templateRegex(FORM_HI.body!).test('नमस्ते Gaurav, LearnXR चैनल पार्टनर बनने में आपकी रुचि के लिए धन्यवाद।\n\nहमारी टीम से Asha कॉल करेंगे।')).toBe(true);
    expect(templateRegex(FORM_EN.body!).test('Hi Gaurav, thanks')).toBe(false);
  });
});

describe('sentTemplates', () => {
  it('finds sent templates in any language and remembers the last language', () => {
    const sent = sentTemplates(ALL, ['Hello there', 'नमस्ते Ravi, LearnXR चैनल पार्टनर बनने में आपकी रुचि के लिए धन्यवाद।\n\nहमारी टीम से Asha कॉल करेंगे।']);
    expect([...sent.keys]).toEqual(['lxr_partner_form']);
    expect(sent.lastLang).toBe('hi');
  });

  it('ignores a template that is only a variable', () => {
    const sent = sentTemplates([t('agent_reply', '{{1}}'), ...ALL], ['Hi Ravi, lxr_school_reply_demo_en. — Team', 'Anything at all']);
    expect([...sent.keys]).toEqual(['lxr_school_reply_demo']);
  });

  it('counts an older school reply as its newer version too', () => {
    const sent = sentTemplates(ALL, ['Hi Ravi, positive_reply. — Team']);
    expect([...sent.keys]).toEqual(['positive_reply', 'lxr_school_reply_positive']);
  });
});

describe('suggestedKeys', () => {
  const partner = templatesFor(ALL, 'partner');
  it('starts a partner with the form and book-a-call', () => {
    expect(suggestedKeys(partner, 'partner', new Set(), lead)).toEqual(['lxr_partner_form', 'lxr_partner_book_call']);
  });

  it('moves a partner to the step after the last one sent', () => {
    expect(suggestedKeys(partner, 'partner', new Set(['lxr_partner_form']), lead)).toEqual(['lxr_partner_step1_welcome']);
    expect(suggestedKeys(partner, 'partner', new Set(['lxr_partner_form', 'lxr_partner_step2_product_kit']), lead)).toEqual([
      'lxr_partner_step3_commercials',
    ]);
    expect(suggestedKeys(partner, 'partner', new Set(['lxr_partner_step3_commercials']), lead)).toEqual([]);
  });

  it('gives a school after its demo the next onboarding step', () => {
    const school = templatesFor(ALL, 'school');
    expect(suggestedKeys(school, 'school', new Set(), { stage: 'Demo done', replyIntent: '' })).toEqual(['lxr_school_step1_demo_recap']);
    expect(suggestedKeys(school, 'school', new Set(['lxr_school_step1_demo_recap']), { stage: 'Proposal', replyIntent: '' })).toEqual([
      'lxr_school_step2_proposal',
    ]);
  });

  it('answers a school by its reply intent until it has been sent', () => {
    const school = templatesFor(ALL, 'school');
    expect(suggestedKeys(school, 'school', new Set(), { stage: 'Engaged', replyIntent: 'demo' })).toEqual(['lxr_school_reply_demo']);
    expect(suggestedKeys(school, 'school', new Set(), { stage: 'Engaged', replyIntent: 'question' })).toEqual(['lxr_school_reply_neutral']);
    expect(suggestedKeys(school, 'school', new Set(), lead)).toEqual(['lxr_school_reply_positive']);
    expect(suggestedKeys(school, 'school', new Set(['lxr_school_reply_positive']), lead)).toEqual([]);
  });

  it('suggests nothing for a number without a lead', () => {
    expect(suggestedKeys(ALL, 'all', new Set(), lead)).toEqual([]);
  });
});

describe('arrangeTemplates', () => {
  it('puts the suggestion first in the last language used, and sent templates last', () => {
    const partner = templatesFor(ALL, 'partner');
    const out = arrangeTemplates(partner, ['lxr_partner_step2_product_kit'], new Set(['lxr_partner_form']), 'hi');
    expect(out.suggested.map((x) => x.name)).toEqual(['lxr_partner_step2_product_kit_hi', 'lxr_partner_step2_product_kit_en']);
    expect(out.sent.map((x) => x.name)).toEqual(['lxr_partner_form_en', 'lxr_partner_form_hi']);
    expect(out.rest.map((x) => x.name)).toEqual(['lxr_partner_book_call_en', 'lxr_partner_step1_welcome_en', 'lxr_partner_step3_commercials_en']);
  });
});
