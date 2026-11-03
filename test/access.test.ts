import { describe, expect, it, vi } from 'vitest';
import { filterVisible } from '../src/core/access';

describe('filterVisible', () => {
  it('keeps only what the user can see and counts the rest', async () => {
    const deps = {
      visibleIssueIds: vi.fn(async () => new Set(['10'])),
      visiblePageIds: vi.fn(async () => new Set(['500'])),
    };
    const items = [
      { id: 'a', event: { source: 'jira', artifactId: '10' } },
      { id: 'b', event: { source: 'jsm', artifactId: '11' } },
      { id: 'c', event: { source: 'confluence', artifactId: '500' } },
      { id: 'd', event: { source: 'confluence', artifactId: '501' } },
      { id: 'e', event: undefined },
    ];
    const { visible, hiddenCount } = await filterVisible(items, deps);
    expect(visible.map((v) => v.id)).toEqual(['a', 'c']);
    expect(hiddenCount).toBe(3);
    expect(deps.visibleIssueIds).toHaveBeenCalledWith(['10', '11']);
    expect(deps.visiblePageIds).toHaveBeenCalledWith(['500', '501']);
  });

  it('makes no calls for an empty list', async () => {
    const deps = { visibleIssueIds: vi.fn(), visiblePageIds: vi.fn() };
    expect(await filterVisible([], deps)).toEqual({ visible: [], hiddenCount: 0 });
    expect(deps.visibleIssueIds).not.toHaveBeenCalled();
  });
});
