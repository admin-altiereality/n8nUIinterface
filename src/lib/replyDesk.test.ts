import { describe, expect, it } from 'vitest';
import { checkDraft, classifyReply, draftReply, listReplies, toReplyItem } from './replyDesk';

const NOW = Date.parse('2026-11-07T09:30:00Z');
const iso = (t: number) => new Date(t).toISOString();
const reply = (extra: Record<string, string> = {}) => ({
  Lead_id: 'abc123',
  Stage: 'Engaged',
  Replied_at: iso(NOW - 3_600_000),
  Reply_channel: 'email',
  Reply_snippet: 'Please share more details',
  Reply_intent: 'question',
  Reply_confidence: '0.9',
  ...extra,
});

describe('classifyReply', () => {
  it('lets the words beat the label for opt-outs and legal threats', () => {
    expect(classifyReply('please unsubscribe us', 'positive', 1).action).toBe('opt_out');
    expect(classifyReply('we will send a legal notice', 'question', 1).action).toBe('read');
  });

  it('sends unsure, empty and negative replies to a person', () => {
    expect(classifyReply('maybe', 'question', 0.4).action).toBe('read');
    expect(classifyReply('', 'question', 1).action).toBe('read');
    expect(classifyReply('no thank you', 'not_interested', 1).action).toBe('close');
    expect(classifyReply('I am away', 'auto_reply', 1).action).toBe('auto');
  });
});

describe('toReplyItem', () => {
  it('is open until someone touches it or sets a next step', () => {
    expect(toReplyItem(reply(), NOW).open).toBe(true);
    expect(toReplyItem(reply({ First_touch_at: iso(NOW) }), NOW).open).toBe(false);
    expect(toReplyItem(reply({ Next_step: 'Call Monday' }), NOW).open).toBe(false);
  });

  it('does not count the next step Inbound sets by itself as an answer', () => {
    expect(toReplyItem(reply({ Next_step: 'Answer their WhatsApp question' }), NOW).open).toBe(true);
    expect(toReplyItem(reply({ Next_step: 'Share pricing on WhatsApp' }), NOW).open).toBe(true);
    expect(toReplyItem(reply({ Next_step: 'See if they answered' }), NOW).open).toBe(false);
  });

  it('reopens when they reply after our first touch', () => {
    expect(toReplyItem(reply({ First_touch_at: iso(NOW - 7_200_000) }), NOW).open).toBe(true);
  });

  it('closes on do-not-contact and finished deals, even for an opt-out', () => {
    expect(toReplyItem(reply({ Reply_snippet: 'stop', Do_not_contact: 'unsubscribed:x' }), NOW).open).toBe(false);
    expect(toReplyItem(reply({ Stage: 'Lost' }), NOW).open).toBe(false);
  });

  it('keeps an opt-out open until it is marked, even with a next step', () => {
    expect(toReplyItem(reply({ Reply_snippet: 'stop messaging', Next_step: 'Call' }), NOW).open).toBe(true);
  });

  it('reads older WhatsApp columns and percent confidence', () => {
    const item = toReplyItem({ whatsapp_replied: 'true', whatsapp_reply_message: 'Hi', Reply_confidence: '45' }, NOW);
    expect(item.channel).toBe('whatsapp');
    expect(item.confidence).toBe(0.45);
    expect(item.action).toBe('read');
  });
});

describe('listReplies', () => {
  it('skips leads that never replied and puts open judgement calls first', () => {
    const rows = [
      {},
      reply({ Lead_id: 'done', Next_step: 'Call' }),
      reply({ Lead_id: 'answer' }),
      reply({ Lead_id: 'read', Reply_confidence: '0.2' }),
    ];
    expect(listReplies(rows, NOW).map((r) => r.row.Lead_id)).toEqual(['read', 'answer', 'done']);
  });
});

describe('draftReply and checkDraft', () => {
  const draft = (extra: Record<string, string>) => draftReply(toReplyItem(reply(extra), NOW), 'Asha');

  it('gives nothing to send for replies that should not get an answer', () => {
    expect(draft({ Reply_snippet: 'stop' })).toBe('');
    expect(draft({ Reply_confidence: '0.1' })).toBe('');
  });

  it('never quotes a price and passes its own check', () => {
    const text = draft({ Reply_intent: 'pricing', 'Principal Name': 'Dr Rao' });
    expect(text).toContain('Hello Dr Rao,');
    expect(text).not.toMatch(/₹|\bprice/i);
    expect(checkDraft(text)).toEqual([]);
  });

  it('does not read the booking link as a placeholder', () => {
    expect(checkDraft(draft({ Reply_intent: 'demo' }))).toEqual([]);
  });

  it('blocks a question draft until the rep writes the answer', () => {
    const text = draft({ Reply_intent: 'question' });
    expect(checkDraft(text)[0]).toMatchObject({ level: 'block' });
    expect(checkDraft(text.replace('[Write your answer here]', 'Yes, it works offline.'))).toEqual([]);
  });

  it('warns on pricing, filler, extra links and length', () => {
    const levels = (t: string) => checkDraft(t).map((i) => i.level);
    expect(levels('The price is ₹500')).toEqual(['warn']);
    expect(levels('Just checking in')).toEqual(['warn']);
    expect(levels('https://a.test https://b.test')).toEqual(['warn']);
    expect(levels('word '.repeat(121))).toEqual(['warn']);
    expect(levels('  ')).toEqual(['block']);
  });
});
