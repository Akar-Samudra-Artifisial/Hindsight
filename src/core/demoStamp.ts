import type { DemoArtifact } from '../adapters/repo';
import { STAMP_PAGE_SLOT, STAMP_WATCH_SLOTS } from './demoData';
import { InputError } from './validate';

/**
 * "Stamp demo data" (setup, admin, as the user). Demo content is created by the app, which Teamwork Graph does not
 * count as a person, so reach would find nobody. One honest human touch fixes that: the admin adds a "Reviewed by"
 * note to the S1 page (they become its contributor) and watches the PAY story and the two S2 tickets. Idempotent.
 */

export const STAMP_VERSION_MESSAGE = 'Demo review note added by Hindsight "Stamp demo data"';

const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;
/** Any space Confluence may write between words: whitespace, NBSP (raw or as an entity). */
const SP = String.raw`(?:\s|&nbsp;|&#160;|&#x[aA]0;| )`;
const INLINE = String.raw`<(?!\/?p\b|ri:user\b)[^>]*>`;
/** A "Reviewed by" paragraph followed by a user mention (or the fallback text), however Confluence re-serialises it. */
const STAMP_MARKER = new RegExp(String.raw`<p\b[^>]*>(?:${SP}|${INLINE})*Reviewed${SP}+by(?:${SP}|${INLINE})*(?:<ri:user\b|the${SP}+demo${SP}+admin\b)`, 'i');

/** Storage-format note; the mention renders as the admin's display name. */
export function reviewStamp(accountId: string): string {
  return ACCOUNT_ID.test(accountId) ? `<p>Reviewed by <ac:link><ri:user ri:account-id="${accountId}" /></ac:link>.</p>` : '<p>Reviewed by the demo admin.</p>';
}

export const hasReviewStamp = (storage: string): boolean => STAMP_MARKER.test(storage);

export interface DemoStampDeps {
  listDemoArtifacts(): Promise<DemoArtifact[]>;
  getPageAsUser(pageId: string): Promise<{ title: string; version: number; body: string } | undefined>;
  updatePageAsUser(pageId: string, page: { title: string; body: string; version: number; message: string }): Promise<number>;
  addWatcherAsUser(issueIdOrKey: string, accountId: string): Promise<void>;
}

export interface StampResult {
  /** 1 when the page got the note now. */
  pages: number;
  /** 1 when the page already had it. */
  pagesAlready: number;
  watchers: number;
  failed: string[];
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200);

export async function stampDemo(accountId: string, deps: DemoStampDeps): Promise<StampResult> {
  const artifacts = new Map((await deps.listDemoArtifacts()).map((a) => [a.slot, a]));
  const page = artifacts.get(STAMP_PAGE_SLOT);
  if (!page) throw new InputError('Load demo data first: the demo page was not found.');
  const result: StampResult = { pages: 0, pagesAlready: 0, watchers: 0, failed: [] };

  try {
    const current = await deps.getPageAsUser(page.artifactId);
    if (!current) result.failed.push('page: you cannot view the demo page');
    else if (hasReviewStamp(current.body)) result.pagesAlready = 1;
    else if (current.body.trim() === '') result.failed.push('page: empty body, not overwritten');
    else {
      await deps.updatePageAsUser(page.artifactId, { title: current.title, body: `${current.body}${reviewStamp(accountId)}`, version: current.version + 1, message: STAMP_VERSION_MESSAGE });
      result.pages = 1;
    }
  } catch (err) {
    result.failed.push(`page: ${errorText(err)}`);
  }

  for (const slot of STAMP_WATCH_SLOTS) {
    const issue = artifacts.get(slot);
    if (!issue) {
      result.failed.push(`${slot}: not loaded`);
      continue;
    }
    try {
      await deps.addWatcherAsUser(issue.artifactKey ?? issue.artifactId, accountId);
      result.watchers += 1;
    } catch (err) {
      result.failed.push(`${issue.artifactKey ?? slot}: ${errorText(err)}`);
    }
  }
  return result;
}
