/**
 * Reader permissions: collect runs as the app, so every candidate is checked as the current user before it is shown
 * (incident panel and, later, Rovo actions). Hidden candidates are only counted.
 */

export interface AccessDeps {
  visibleIssueIds(ids: readonly string[]): Promise<Set<string>>;
  visiblePageIds(ids: readonly string[]): Promise<Set<string>>;
}

export interface AccessItem {
  event: { source: string; artifactId: string } | undefined;
}

export async function filterVisible<T extends AccessItem>(items: readonly T[], deps: AccessDeps): Promise<{ visible: T[]; hiddenCount: number }> {
  const issueIds = new Set<string>();
  const pageIds = new Set<string>();
  for (const item of items) {
    if (!item.event) continue;
    if (item.event.source === 'confluence') pageIds.add(item.event.artifactId);
    else issueIds.add(item.event.artifactId);
  }
  const [issues, pages] = await Promise.all([
    issueIds.size > 0 ? deps.visibleIssueIds([...issueIds]) : Promise.resolve(new Set<string>()),
    pageIds.size > 0 ? deps.visiblePageIds([...pageIds]) : Promise.resolve(new Set<string>()),
  ]);
  const visible = items.filter((item) => {
    if (!item.event) return false;
    return item.event.source === 'confluence' ? pages.has(item.event.artifactId) : issues.has(item.event.artifactId);
  });
  return { visible, hiddenCount: items.length - visible.length };
}
