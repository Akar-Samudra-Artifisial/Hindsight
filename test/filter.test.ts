import { describe, expect, it } from 'vitest';
import { CUSTOMER_TICKET_LABEL, daysBefore, filterEvent, isCustomerTicket, isUnansweredQuestion, rankCandidates, type CollectedEvent, type IncidentContext } from '../src/core/filter';
import { extractKeywords } from '../src/core/keywords';

const START = '2026-11-20T10:00:00.000Z';
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(new Date(START).getTime() - d * DAY).toISOString();

const ctx: IncidentContext = {
  serviceKey: 'payments',
  componentNames: ['Checkout'],
  keywords: extractKeywords({
    summary: 'Checkout payments failing',
    description: 'Customers get HTTP 402 and 426 from the payment gateway',
    aliases: ['payment gateway'],
  }),
  windowFrom: daysAgo(30),
  windowTo: START,
  effectiveStart: START,
};

const ev = (over: Partial<CollectedEvent>): CollectedEvent => ({
  eventId: 'e1',
  source: 'jira',
  kind: 'issue',
  title: '',
  text: '',
  projectKey: 'PAY',
  spaceKey: null,
  componentNames: [],
  labels: [],
  serviceKey: 'payments',
  effectiveAt: daysAgo(5),
  replyCount: null,
  statusCategory: null,
  resolutionName: null,
  authorId: 'u1',
  isLastComment: false,
  ...over,
});

describe('filterEvent: the three Arkana signals pass', () => {
  it('Confluence TLS 1.1 deprecation note, 12 days before', () => {
    const d = filterEvent(
      ev({
        eventId: 'tls',
        source: 'confluence',
        kind: 'page',
        projectKey: null,
        spaceKey: 'PLAT',
        title: 'Payment gateway: TLS 1.1 deprecation',
        text: 'The vendor will drop TLS 1.1 on 15 November. Older clients will break.',
        effectiveAt: daysAgo(12.5),
      }),
      ctx,
    );
    expect(d).toMatchObject({ eventId: 'tls', daysBefore: 12, hintType: 'external_change' });
    expect(d?.reasons).toEqual(expect.arrayContaining(['service_match', 'keyword_match', 'risk_term']));
    expect(d?.filterScore).toBe(90);
  });

  it('JSM "payment fails" closed as Cannot Reproduce, 6 days before', () => {
    const d = filterEvent(
      ev({
        eventId: 'jsm',
        source: 'jsm',
        projectKey: 'INC',
        title: 'Payment fails at checkout',
        text: 'Customer says their card payment fails sometimes.',
        resolutionName: 'Cannot Reproduce',
        statusCategory: 'done',
        effectiveAt: daysAgo(6),
      }),
      ctx,
    );
    expect(d).toMatchObject({ daysBefore: 6, hintType: 'customer_complaint' });
    expect(d?.reasons).toContain('jsm_closed_without_fix');
  });

  it('without JSM: a Jira work item labelled as a customer ticket scores like a JSM ticket', () => {
    const ticket = {
      projectKey: 'INC',
      title: 'Payment fails at checkout',
      text: 'My card payment failed twice at checkout this morning.',
      statusCategory: 'done',
      effectiveAt: daysAgo(6),
    };
    const labelled = filterEvent(ev({ ...ticket, labels: ['hindsight-demo', CUSTOMER_TICKET_LABEL] }), ctx);
    const jsm = filterEvent(ev({ ...ticket, source: 'jsm', labels: ['hindsight-demo'] }), ctx);
    expect(labelled).toMatchObject({ hintType: 'customer_complaint', filterScore: jsm?.filterScore });
    expect(labelled?.reasons).toContain('jsm_closed_without_fix');
    const plain = filterEvent(ev({ ...ticket, labels: ['hindsight-demo'] }), ctx);
    expect(plain?.hintType).toBe('technical_warning');
    expect(isCustomerTicket({ source: 'confluence', labels: [CUSTOMER_TICKET_LABEL] })).toBe(false);
  });

  it('unanswered question about 426, 3 days before', () => {
    const d = filterEvent(
      ev({
        eventId: 'q',
        kind: 'comment',
        title: 'Upgrade build agents',
        text: 'Is anyone else seeing 426 from the gateway since Monday?',
        isLastComment: true,
        effectiveAt: daysAgo(3),
      }),
      ctx,
    );
    expect(d).toMatchObject({ daysBefore: 3, hintType: 'unanswered_question' });
    expect(d?.matchedKeywords).toEqual(expect.arrayContaining(['426', 'gateway']));
    expect(d?.reasons).toContain('unanswered_question');
  });
});

describe('filterEvent: rejections', () => {
  it('a same-service distractor without keywords or risk fails', () => {
    expect(filterEvent(ev({ title: 'Team lunch on Friday', text: 'Pizza or sushi?' }), ctx)).toBeUndefined();
  });

  it('another service with a risk word only fails', () => {
    expect(filterEvent(ev({ serviceKey: 'search', title: 'Index rebuild', text: 'Possible timeout during reindex' }), ctx)).toBeUndefined();
  });

  it('same service + risk word passes without keywords', () => {
    expect(filterEvent(ev({ title: 'Cert rotation', text: 'The certificate expires soon' }), ctx)).toBeDefined();
  });

  it('events outside the window are dropped', () => {
    const base = { title: 'Checkout payments failing again', text: '' };
    expect(filterEvent(ev({ ...base, effectiveAt: daysAgo(31) }), ctx)).toBeUndefined();
    expect(filterEvent(ev({ ...base, effectiveAt: START }), ctx)).toBeUndefined();
  });

  it("a comment does not score its issue's title", () => {
    expect(filterEvent(ev({ kind: 'comment', serviceKey: null, title: 'Checkout payments failing', text: 'Looks good to me.' }), ctx)).toBeUndefined();
  });
});

describe('helpers', () => {
  it('isUnansweredQuestion needs a last Jira comment ending with ?', () => {
    expect(isUnansweredQuestion({ source: 'jira', kind: 'comment', text: 'Why? ', isLastComment: true })).toBe(true);
    expect(isUnansweredQuestion({ source: 'jira', kind: 'comment', text: 'Why?', isLastComment: false })).toBe(false);
    expect(isUnansweredQuestion({ source: 'confluence', kind: 'comment', text: 'Why?', isLastComment: true })).toBe(false);
  });

  it('daysBefore floors whole days', () => {
    expect(daysBefore(START, daysAgo(2.9))).toBe(2);
  });

  it('excerpt is at most 2000 characters around the first keyword', () => {
    const d = filterEvent(ev({ title: 'Long note', text: `${'filler '.repeat(800)}the payment gateway returns 402 ${'tail '.repeat(800)}` }), ctx);
    expect(d?.excerpt.length).toBeLessThanOrEqual(2000);
    expect(d?.excerpt).toContain('payment gateway');
  });
});

describe('rankCandidates', () => {
  const items = Array.from({ length: 250 }, (_, i) => ({ eventId: `e${String(i).padStart(3, '0')}`, filterScore: 20 + (i % 7) * 10, daysBefore: i % 30 }));

  it('keeps the best 200 and truncates the rest, without mutating the input', () => {
    const copy = JSON.stringify(items);
    const { kept, truncated } = rankCandidates(items, 200);
    expect(kept).toHaveLength(200);
    expect(truncated).toHaveLength(50);
    expect(JSON.stringify(items)).toBe(copy);
    const worstKept = kept[kept.length - 1];
    const bestTruncated = truncated[0];
    expect(worstKept && bestTruncated && worstKept.filterScore >= bestTruncated.filterScore).toBe(true);
  });

  it('orders by score, then oldest, then event id — deterministically', () => {
    const { kept } = rankCandidates([
      { eventId: 'b', filterScore: 50, daysBefore: 3 },
      { eventId: 'a', filterScore: 50, daysBefore: 3 },
      { eventId: 'c', filterScore: 50, daysBefore: 9 },
      { eventId: 'd', filterScore: 90, daysBefore: 1 },
    ]);
    expect(kept.map((k) => k.eventId)).toEqual(['d', 'c', 'a', 'b']);
    expect(rankCandidates([...items].reverse(), 200).kept).toEqual(rankCandidates(items, 200).kept);
  });
});
