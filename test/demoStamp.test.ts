import { describe, expect, it, vi } from 'vitest';
import { hasReviewStamp, reviewStamp, stampDemo, STAMP_VERSION_MESSAGE, type DemoStampDeps } from '../src/core/demoStamp';

const artifacts = [
  { slot: 'distractor:plat-01', artifactId: '5079131', artifactKey: null },
  { slot: 'context:pay-story', artifactId: '10052', artifactKey: 'PAY-52' },
  { slot: 'signal:s2a-jsm', artifactId: '10046', artifactKey: 'INC-46' },
  { slot: 'signal:s2b-jsm', artifactId: '10047', artifactKey: 'INC-47' },
];

function deps(body = '<p>Planned vendor maintenance.</p>') {
  return {
    listDemoArtifacts: vi.fn<DemoStampDeps['listDemoArtifacts']>(async () => artifacts as never),
    getPageAsUser: vi.fn<DemoStampDeps['getPageAsUser']>(async () => ({ title: 'Vendor integrations: Q4 maintenance calendar', version: 3, body })),
    updatePageAsUser: vi.fn<DemoStampDeps['updatePageAsUser']>(async () => 4),
    addWatcherAsUser: vi.fn<DemoStampDeps['addWatcherAsUser']>(async () => undefined),
  };
}

describe('stampDemo', () => {
  it('adds the review note once and watches the story and both S2 tickets', async () => {
    const d = deps();
    expect(await stampDemo('557058:abc', d)).toEqual({ pages: 1, pagesAlready: 0, watchers: 3, failed: [] });
    expect(d.updatePageAsUser).toHaveBeenCalledWith('5079131', {
      title: 'Vendor integrations: Q4 maintenance calendar',
      body: '<p>Planned vendor maintenance.</p><p>Reviewed by <ac:link><ri:user ri:account-id="557058:abc" /></ac:link>.</p>',
      version: 4,
      message: STAMP_VERSION_MESSAGE,
    });
    expect(d.addWatcherAsUser.mock.calls.map((c) => c[0])).toEqual(['PAY-52', 'INC-46', 'INC-47']);
  });

  it('is idempotent: a stamped page is not written again', async () => {
    const d = deps(`<p>x</p><p>Reviewed&nbsp;by <ac:link><ri:user ri:account-id="557058:abc"/></ac:link>.</p>`);
    expect(await stampDemo('557058:abc', d)).toMatchObject({ pages: 0, pagesAlready: 1, watchers: 3 });
    expect(d.updatePageAsUser).not.toHaveBeenCalled();
  });

  it('reports failures per item and refuses without demo data', async () => {
    const d = deps();
    d.addWatcherAsUser.mockRejectedValueOnce(new Error('Jira 403: no permission'));
    expect(await stampDemo('557058:abc', d)).toMatchObject({ watchers: 2, failed: ['PAY-52: Jira 403: no permission'] });
    d.listDemoArtifacts.mockResolvedValue([]);
    await expect(stampDemo('557058:abc', d)).rejects.toThrow('Load demo data first');
  });

  it('marker and fallback note', () => {
    expect(reviewStamp('bad id"')).toBe('<p>Reviewed by the demo admin.</p>');
    expect(hasReviewStamp(reviewStamp('bad id"'))).toBe(true);
    expect(hasReviewStamp('<p>Reviewed later</p>')).toBe(false);
  });
});
