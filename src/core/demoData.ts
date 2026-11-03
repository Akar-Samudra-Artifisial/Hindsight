import type { AdfDoc } from '../adapters/jira';
import type { DemoRole } from '../adapters/repo';
import { CUSTOMER_TICKET_LABEL } from './filter';

/**
 * Arkana Commerce demo scenario (pure data). Three early signals before the "Checkout payments failing" incident,
 * hidden among 40 distractors in the same projects and space. Every artifact gets a scenario time relative to the
 * incident start T0, so the 30-day window and the filter behave as if the history were real.
 */

const DAY_MIN = 24 * 60;

export const DEMO = {
  label: 'hindsight-demo',
  /** Extra label of the INC customer tickets, so they count as customer complaints even without JSM. */
  customerLabel: CUSTOMER_TICKET_LABEL,
  serviceKey: 'checkout',
  pay: {
    key: 'PAY',
    name: 'Arkana Payments',
    description: 'Arkana Commerce payments engineering (Hindsight demo data).',
    projectTypeKey: 'software' as const,
    projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-simplified-kanban-classic',
  },
  inc: {
    key: 'INC',
    name: 'Arkana Support',
    description: 'Arkana Commerce customer support and incidents (Hindsight demo data).',
    projectTypeKey: 'service_desk' as const,
    projectTemplateKey: 'com.atlassian.servicedesk:simplified-it-service-management',
  },
  space: { key: 'PLAT', name: 'Arkana Platform', description: 'Arkana Commerce platform engineering (Hindsight demo data).' },
  incident: {
    summary: 'Checkout payments failing',
    description: 'Checkout is down. The payment gateway responds with HTTP 426 Upgrade Required for most card payments since 09:12 UTC.',
  },
  /** Minutes between the scenario incident start and its resolution. */
  incidentDurationMinutes: 180,
  cannotReproduce: 'Cannot Reproduce',
  closingComment: 'We could not reproduce this on our side. Closing for now.',
  mapping: {
    serviceKey: 'checkout',
    displayName: 'Checkout (Arkana Commerce)',
    jiraProjectKeys: ['PAY', 'INC'],
    jiraComponentNames: ['Checkout'],
    confluenceSpaceKeys: ['PLAT'],
    aliases: ['payment gateway', 'card payments'],
    ownerTeamName: 'Payments',
    ownerTeamId: null,
  },
} as const;

export type DemoProject = 'PAY' | 'INC';
export type DemoIssueType = 'task' | 'story' | 'request' | 'incident';

interface SpecBase {
  slot: string;
  role: DemoRole;
  /** Scenario time = T0 − minutesBefore. */
  minutesBefore: number;
}

export type DemoSpec =
  | (SpecBase & { kind: 'issue'; project: DemoProject; issueType: DemoIssueType; title: string; body: string; closeAsCannotReproduce?: boolean })
  | (SpecBase & { kind: 'issue-comment'; parent: string; body: string })
  | (SpecBase & { kind: 'page'; title: string; body: string; table?: readonly (readonly [string, string])[] })
  | (SpecBase & { kind: 'page-comment'; parent: string; body: string });

/**
 * Stems of the incident keywords and the risk terms; no distractor may contain them (guarded by a test), so the
 * filter drops every distractor and keeps only the signals.
 */
export const FORBIDDEN_STEMS: readonly string[] = [
  'checkout',
  'payment',
  'fail',
  'gateway',
  'card',
  'down',
  'respond',
  'http',
  '426',
  'upgrade',
  'requir',
  'since',
  '09',
  '12',
  'utc',
];

// --- Signals and their context -------------------------------------------------------------------

const S1_PARENT = 'distractor:plat-01';
const STORY = 'context:pay-story';
const S2A = 'signal:s2a-jsm';
const S2B = 'signal:s2b-jsm';
/** "Stamp demo data": the page the admin reviews (S1's parent) and the issues they watch (story + the two S2 tickets). */
export const STAMP_PAGE_SLOT = S1_PARENT;
export const STAMP_WATCH_SLOTS: readonly string[] = [STORY, S2A, S2B];

const SIGNALS: readonly DemoSpec[] = [
  {
    kind: 'issue',
    slot: STORY,
    role: 'context',
    project: 'PAY',
    issueType: 'story',
    title: 'Upgrade payment client',
    body: 'Move the sandbox integration to client library 4.x before the holiday freeze.',
    minutesBefore: 9 * DAY_MIN,
  },
  {
    kind: 'issue-comment',
    slot: 'distractor:pay-story-c1',
    role: 'distractor',
    parent: STORY,
    body: 'Bumped the client to 4.2 in the sandbox branch, smoke tests green.',
    minutesBefore: 4 * DAY_MIN,
  },
  {
    kind: 'issue-comment',
    slot: 'signal:s3-unanswered',
    role: 'signal',
    parent: STORY,
    body: 'Since Monday the sandbox gateway responds with HTTP 426 Upgrade Required on about one in five card payments. Is it rejecting our TLS version, or is this a client bug?',
    minutesBefore: 3 * DAY_MIN,
  },
  {
    kind: 'issue',
    slot: S2A,
    role: 'signal',
    project: 'INC',
    issueType: 'request',
    title: 'Payment fails at checkout',
    body: 'My card payment failed twice at checkout this morning, then the third try went through. Order ARK-20931.',
    minutesBefore: 6 * DAY_MIN,
    closeAsCannotReproduce: true,
  },
  { kind: 'issue-comment', slot: 'context:s2a-closing', role: 'context', parent: S2A, body: DEMO.closingComment, minutesBefore: 6 * DAY_MIN - 120 },
  {
    kind: 'issue',
    slot: S2B,
    role: 'signal',
    project: 'INC',
    issueType: 'request',
    title: 'Checkout says payment could not be completed',
    body: 'Paying with a saved card at checkout shows "payment could not be completed". It worked when I tried again an hour later.',
    minutesBefore: 6 * DAY_MIN - 180,
    closeAsCannotReproduce: true,
  },
  { kind: 'issue-comment', slot: 'context:s2b-closing', role: 'context', parent: S2B, body: DEMO.closingComment, minutesBefore: 6 * DAY_MIN - 300 },
  {
    kind: 'page-comment',
    slot: 'signal:s1-vendor-tls',
    role: 'signal',
    parent: S1_PARENT,
    body: 'Heads-up from the payment gateway vendor: they will drop TLS 1.1 on 15 November and only accept TLS 1.2 or newer. Older clients will break after that date. Does anything of ours still negotiate 1.1?',
    minutesBefore: 12 * DAY_MIN,
  },
];

// --- Distractors ---------------------------------------------------------------------------------

const PAY_TASKS: readonly (readonly [string, string])[] = [
  ['Add Apple Pay button to the mobile wallet sheet', 'Design is final in Figma; implement behind the wallet_sheet flag.'],
  ['Refund ledger export to the finance warehouse', 'Nightly CSV of refunds into the finance schema, owned by Data.'],
  ['Rotate the Slack webhook for the on-call channel', 'Old webhook was shared in a public doc; create a new one.'],
  ['Flaky unit test in CurrencyFormatter on Node 24', 'Passes alone, flakes in the full suite about one run in ten.'],
  ['Dashboard: settlement totals per region', 'Add EMEA and LATAM tiles next to the global total.'],
  ['Sprint 41 review notes', 'Velocity 34, two items carried over, demo went well.'],
  ['Migrate invoice PDFs to the new storage bucket', 'Copy with lifecycle rules, then switch the signed URL generator.'],
  ['Rename internal package com.arkana.pay.core', 'Align with the monorepo naming guide; no behaviour change.'],
  ['Document the fraud-rule tuning process', 'Write the runbook the analysts asked for in the last review.'],
  ['Onboarding checklist for new ledger engineers', 'Accounts, sandbox access, and the first-week reading list.'],
  ['Bump Node to 24 on build agents', 'Images are built; roll out agent pool by pool.'],
  ['Localise refund emails for pt-BR and es-MX', 'Strings are in the sheet; translations arrive Friday.'],
  ['Clean up feature flags from the loyalty launch', 'Four flags are fully on; remove them and the dead code.'],
  ['Reduce log volume of the reconciliation worker', 'Drop per-row debug lines; keep summaries per batch.'],
  ['Spike: evaluate Kotlin for the ledger service', 'Two-day spike, write-up in the engineering space.'],
  ['Quarterly access review for the fraud console', 'Export the user list and confirm with each team lead.'],
];

const INC_REQUESTS: readonly (readonly [string, string])[] = [
  ['Cannot reset my password from the account page', 'The reset email never arrives, checked spam too.'],
  ['Promo code SPRING10 not applied in basket', 'Code is valid until Sunday according to the newsletter.'],
  ['Order ARK-20877 shows as shipped but tracking link is empty', 'Carrier page says no shipment found.'],
  ['Wrong size delivered for order ARK-20902', 'Ordered M, received L; want an exchange.'],
  ['Newsletter unsubscribe link goes to a blank page', 'Happens on both phone and laptop.'],
  ['Gift wrap option missing for the holiday bundle', 'It was there last week for the same bundle.'],
  ['Product photos load slowly on the mobile site', 'Takes several seconds on 4G, fine on wifi.'],
  ['Wishlist items disappear after logging out', 'Saved six items, only two remain after login.'],
  ['Request invoice copy for order ARK-20850', 'Need a PDF with the company VAT number.'],
  ['Loyalty points not credited for last order', 'Order ARK-20910 delivered on Monday, balance unchanged.'],
  ['Search shows discontinued items', 'Results list a kettle that is no longer sold.'],
  ['Address form rejects postcodes with spaces', 'UK postcode with a space is marked invalid.'],
];

interface PageDraft {
  title: string;
  body: string;
  table?: readonly (readonly [string, string])[];
  comment?: string;
}

const PLAT_PAGES: readonly PageDraft[] = [
  {
    title: 'Vendor integrations: Q4 maintenance calendar',
    body: 'Planned vendor maintenance this quarter.',
    table: [
      ['Search cluster reindex', '8 Nov'],
      ['Email provider migration', '20 Nov'],
      ['CDN contract renewal', '2 Dec'],
    ],
  },
  { title: 'Kubernetes 1.31 cluster rollout plan', body: 'Staging first, then one production cluster per week.', comment: 'Can we schedule the rollout after the holiday freeze?' },
  { title: 'On-call handbook: escalation ladder', body: 'Primary, secondary, then the engineering manager of the owning team.', comment: 'Added the new pager rotation for November.' },
  { title: 'Postmortem template (blameless)', body: 'Timeline, impact, contributing factors, follow-ups. Describe systems, not people.' },
  { title: 'Logging and metrics retention policy', body: 'Application logs 30 days, metrics 13 months, audit logs 24 months.', comment: 'Do we keep audit logs for 18 months or 24?' },
  { title: 'Build pipeline conventions', body: 'One workflow per service, caches keyed by lockfile hash.' },
];

const PAY_COMMENTS: Readonly<Record<number, string>> = {
  4: 'Passes locally with the TZ pinned, looks like a timezone thing.',
  7: 'Bucket created, waiting for the IAM policy.',
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Deterministic spread over the window: day 1–28 and hour 8–16 before T0, by distractor index. */
export function distractorMinutesBefore(i: number): number {
  return (1 + ((i * 11) % 28)) * DAY_MIN + (8 + (i % 9)) * 60;
}

/** A distractor comment one day after its parent (but at least an hour before T0). */
const commentAfter = (parentMinutes: number) => Math.max(60, parentMinutes - DAY_MIN);

function buildDistractors(): DemoSpec[] {
  const out: DemoSpec[] = [];
  let i = 0;
  const next = () => distractorMinutesBefore(i++);
  PAY_TASKS.forEach(([title, body], idx) => {
    const n = idx + 1;
    const slot = `distractor:pay-${pad(n)}`;
    const minutesBefore = next();
    out.push({ kind: 'issue', slot, role: 'distractor', project: 'PAY', issueType: 'task', title, body, minutesBefore });
    const comment = PAY_COMMENTS[n];
    if (comment) out.push({ kind: 'issue-comment', slot: `${slot}-c`, role: 'distractor', parent: slot, body: comment, minutesBefore: commentAfter(minutesBefore) });
  });
  INC_REQUESTS.forEach(([title, body], idx) => {
    out.push({ kind: 'issue', slot: `distractor:inc-${pad(idx + 1)}`, role: 'distractor', project: 'INC', issueType: 'request', title, body, minutesBefore: next() });
  });
  PLAT_PAGES.forEach((p, idx) => {
    const slot = `distractor:plat-${pad(idx + 1)}`;
    // The S1 container page must exist before the vendor comment 12 days before T0.
    const minutesBefore = idx === 0 ? 20 * DAY_MIN : next();
    out.push({ kind: 'page', slot, role: 'distractor', title: p.title, body: p.body, ...(p.table ? { table: p.table } : {}), minutesBefore });
    if (p.comment) out.push({ kind: 'page-comment', slot: `${slot}-c`, role: 'distractor', parent: slot, body: p.comment, minutesBefore: commentAfter(minutesBefore) });
  });
  return out;
}

/**
 * Every demo artifact except the incident, in creation order: PAY issues and comments, INC tickets and closing
 * comments, then PLAT pages and comments (a parent always comes before its comments).
 */
export const DEMO_ARTIFACTS: readonly DemoSpec[] = (() => {
  const all = [...SIGNALS, ...buildDistractors()];
  const rank = (s: DemoSpec): number => {
    if (s.kind === 'page' || s.kind === 'page-comment') return s.kind === 'page' ? 4 : 5;
    const project = s.kind === 'issue' ? s.project : (all.find((p) => p.slot === s.parent) as { project?: DemoProject } | undefined)?.project;
    return (project === 'PAY' ? 0 : 2) + (s.kind === 'issue' ? 0 : 1);
  };
  return all.map((s, idx) => ({ s, idx })).sort((a, b) => rank(a.s) - rank(b.s) || a.idx - b.idx).map((x) => x.s);
})();

export const INCIDENT_SLOT = 'incident';

export const scenarioAt = (t0: string, minutesBefore: number): string => new Date(new Date(t0).getTime() - minutesBefore * 60_000).toISOString();

/** T0 for a new seed: 24 hours before `now`, rounded down to the minute. */
export function newScenarioStart(now: number): string {
  const t = now - DAY_MIN * 60_000;
  return new Date(t - (t % 60_000)).toISOString();
}

// --- Bodies --------------------------------------------------------------------------------------

export function adfParagraphs(text: string): AdfDoc {
  return {
    type: 'doc',
    version: 1,
    content: text.split('\n').map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })),
  };
}

const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function storageParagraphs(text: string): string {
  return text
    .split('\n')
    .map((line) => `<p>${escapeXml(line)}</p>`)
    .join('');
}

export function pageStorage(spec: { body: string; table?: readonly (readonly [string, string])[] }): string {
  const table = spec.table
    ? `<table><tbody><tr><th>Change</th><th>Date</th></tr>${spec.table.map(([a, b]) => `<tr><td>${escapeXml(a)}</td><td>${escapeXml(b)}</td></tr>`).join('')}</tbody></table>`
    : '';
  return `${storageParagraphs(spec.body)}${table}`;
}

/** Issue type for a demo issue from the project's creatable types (names differ between templates and sites). */
export function pickIssueType(types: readonly { id: string; name: string }[], want: DemoIssueType): { id: string; name: string } | undefined {
  const by = (re: RegExp) => types.find((t) => re.test(t.name));
  const fallback = by(/^task$/i) ?? types[0];
  switch (want) {
    case 'incident':
      return by(/^(\[system\]\s*)?incident$/i) ?? types.find((t) => /incident/i.test(t.name) && !/post/i.test(t.name)) ?? by(/^bug$/i) ?? fallback;
    case 'request':
      return by(/^(\[system\]\s*)?service request$/i) ?? by(/service request/i) ?? by(/request/i) ?? fallback;
    case 'story':
      return by(/^story$/i) ?? fallback;
    case 'task':
      return fallback;
  }
}
