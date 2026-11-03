import { describe, expect, it } from 'vitest';
import {
  adfParagraphs,
  DEMO,
  DEMO_ARTIFACTS,
  FORBIDDEN_STEMS,
  newScenarioStart,
  pageStorage,
  pickIssueType,
  scenarioAt,
  storageParagraphs,
  type DemoSpec,
} from '../src/core/demoData';
import { filterEvent, RISK_TERMS, type CollectedEvent, type IncidentContext } from '../src/core/filter';
import { extractKeywords, MAX_KEYWORDS, stem, tokenise } from '../src/core/keywords';
import { adfToText, normaliseText, storageToText } from '../src/core/text';

const T0 = '2026-11-02T09:12:00.000Z';
const DAY = 86_400_000;

const ctx: IncidentContext = {
  serviceKey: 'checkout',
  componentNames: [],
  keywords: extractKeywords({ summary: DEMO.incident.summary, description: DEMO.incident.description, aliases: [...DEMO.mapping.aliases] }),
  windowFrom: new Date(new Date(T0).getTime() - 30 * DAY).toISOString(),
  windowTo: T0,
  effectiveStart: T0,
};

const bySlot = new Map(DEMO_ARTIFACTS.map((s) => [s.slot, s]));

function parentOf(spec: DemoSpec): DemoSpec | undefined {
  return spec.kind === 'issue-comment' || spec.kind === 'page-comment' ? bySlot.get(spec.parent) : undefined;
}

/** The event collect would build for the spec: text via the same ADF/storage converters, title of the parent for comments. */
function eventOf(spec: DemoSpec, opts: { statusCategory?: string | null; isLastComment?: boolean } = {}): CollectedEvent {
  const parent = parentOf(spec);
  const source =
    spec.kind === 'page' || spec.kind === 'page-comment'
      ? 'confluence'
      : (spec.kind === 'issue' ? spec.project : (parent as { project?: string }).project) === 'INC'
        ? 'jsm'
        : 'jira';
  const text =
    spec.kind === 'page'
      ? normaliseText(storageToText(pageStorage(spec)))
      : spec.kind === 'page-comment'
        ? normaliseText(storageToText(storageParagraphs(spec.body)))
        : normaliseText(adfToText(adfParagraphs(spec.body)));
  const title = spec.kind === 'issue' || spec.kind === 'page' ? spec.title : ((parent as { title?: string }).title ?? '');
  return {
    eventId: spec.slot,
    source,
    kind: spec.kind === 'issue' ? 'issue' : spec.kind === 'page' ? 'page' : 'comment',
    title,
    text,
    projectKey: source === 'confluence' ? null : source === 'jsm' ? 'INC' : 'PAY',
    spaceKey: source === 'confluence' ? 'PLAT' : null,
    componentNames: [],
    labels: [DEMO.label],
    serviceKey: 'checkout',
    effectiveAt: scenarioAt(T0, spec.minutesBefore),
    replyCount: null,
    statusCategory: opts.statusCategory ?? null,
    resolutionName: null,
    authorId: 'app',
    isLastComment: opts.isLastComment ?? false,
  };
}

describe('demo keywords', () => {
  it('stay within MAX_KEYWORDS and are all covered by FORBIDDEN_STEMS (down is a stopword)', () => {
    expect(ctx.keywords.length).toBeLessThanOrEqual(MAX_KEYWORDS);
    for (const k of ctx.keywords) expect(FORBIDDEN_STEMS).toContain(k.stem);
  });
});

describe('demo signals', () => {
  it.each([
    ['signal:s1-vendor-tls', 'external_change', 12, {}],
    ['signal:s2a-jsm', 'customer_complaint', 6, { statusCategory: 'done' }],
    ['signal:s2b-jsm', 'customer_complaint', 5, { statusCategory: 'done' }],
    ['signal:s3-unanswered', 'unanswered_question', 3, { isLastComment: true }],
  ] as const)('%s passes the filter as %s, %i days before', (slot, hint, days, opts) => {
    const draft = filterEvent(eventOf(bySlot.get(slot)!, opts), ctx);
    expect(draft).toBeDefined();
    expect(draft?.hintType).toBe(hint);
    expect(draft?.daysBefore).toBe(days);
  });

  it('S2 tickets get the closed-without-fix points once done', () => {
    expect(filterEvent(eventOf(bySlot.get('signal:s2a-jsm')!, { statusCategory: 'done' }), ctx)?.reasons).toContain('jsm_closed_without_fix');
  });
});

describe('demo distractors', () => {
  const distractors = DEMO_ARTIFACTS.filter((s) => s.role === 'distractor');

  it('there are 40 of them', () => {
    expect(distractors).toHaveLength(40);
  });

  it.each(distractors.map((s) => [s.slot, s]))('%s has no keyword stem or risk term and is dropped by the filter', (_slot, spec) => {
    const ev = eventOf(spec, { isLastComment: true });
    const scored = `${ev.kind === 'comment' ? '' : ev.title}\n${ev.text}`;
    const found = tokenise(scored).map(stem).filter((s) => FORBIDDEN_STEMS.includes(s));
    expect(found).toEqual([]);
    expect(RISK_TERMS.test(scored)).toBe(false);
    expect(filterEvent(ev, ctx)).toBeUndefined();
  });

  it('closing comments are dropped as well', () => {
    expect(filterEvent(eventOf(bySlot.get('context:s2a-closing')!, { statusCategory: 'done', isLastComment: true }), ctx)).toBeUndefined();
  });
});

describe('demo artifacts', () => {
  it('have unique slots ≤ 64 characters, scenario times inside the 30-day window, parents before comments', () => {
    const slots = DEMO_ARTIFACTS.map((s) => s.slot);
    expect(new Set(slots).size).toBe(slots.length);
    DEMO_ARTIFACTS.forEach((s, i) => {
      expect(s.slot.length).toBeLessThanOrEqual(64);
      expect(s.minutesBefore).toBeGreaterThan(0);
      expect(s.minutesBefore).toBeLessThan(30 * 24 * 60);
      const parent = parentOf(s);
      if (s.kind === 'issue-comment' || s.kind === 'page-comment') {
        expect(parent).toBeDefined();
        expect(DEMO_ARTIFACTS.indexOf(parent!)).toBeLessThan(i);
      }
    });
  });

  it('S3 is the last comment on the story', () => {
    const storyComments = DEMO_ARTIFACTS.filter((s) => s.kind === 'issue-comment' && s.parent === 'context:pay-story');
    expect(storyComments.at(-1)?.slot).toBe('signal:s3-unanswered');
  });
});

describe('helpers', () => {
  it('newScenarioStart is 24 h earlier, on a whole minute', () => {
    expect(newScenarioStart(Date.parse('2026-11-03T10:15:42.123Z'))).toBe('2026-11-02T10:15:00.000Z');
  });
  it('pickIssueType prefers exact names and skips post-incident review', () => {
    const types = [
      { id: '1', name: '[System] Post-incident review' },
      { id: '2', name: '[System] Incident' },
      { id: '3', name: '[System] Service request' },
      { id: '4', name: 'Task' },
    ];
    expect(pickIssueType(types, 'incident')?.id).toBe('2');
    expect(pickIssueType(types, 'request')?.id).toBe('3');
    expect(pickIssueType(types, 'story')?.id).toBe('4');
  });
  it('storage escapes markup', () => {
    expect(storageParagraphs('a < b & "c"')).toBe('<p>a &lt; b &amp; &quot;c&quot;</p>');
  });
});
