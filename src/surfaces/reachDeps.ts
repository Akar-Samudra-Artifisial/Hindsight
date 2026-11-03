import { Queue } from '@forge/events';
import { confluence, isConfluenceRateLimited } from '../adapters/confluence';
import { isJiraRateLimited, jira } from '../adapters/jira';
import { repo } from '../adapters/repo';
import { createTeamLookup } from '../adapters/teamworkGraph';
import type { ReachFlowDeps } from '../core/reachFlow';

const scoreQueue = new Queue({ key: 'score' });

/**
 * Production wiring of the reach flow for resolvers and Rovo actions. `cloudId` comes from the invocation context
 * when present, else from Jira `/_edge/tenant_info` [VERIFY]. The dossier is rewritten by the `score` consumer
 * (graph writes only from consumers): pushing a done job only refreshes its dossier.
 */
export function reachDeps(contextCloudId: string | undefined): ReachFlowDeps {
  return {
    repo,
    getIncidentAsUser: (key) => jira.getIncidentAsUser(key),
    isAdminAsUser: () => jira.isAdminAsUser(),
    visibleIssueIds: (ids) => jira.visibleIssueIds(ids),
    visiblePageIds: (ids) => confluence.visiblePageIds(ids),
    cloudId: async () => contextCloudId ?? (await jira.cloudId()),
    watchersOf: (issueId) => jira.getWatchers(issueId),
    pageVersionAuthors: (pageId) => confluence.getPageVersionAuthorsAsUser(pageId),
    isRateLimited: (err) => isJiraRateLimited(err) || isConfluenceRateLimited(err),
    teamLookup: (cloudId) => createTeamLookup(cloudId),
    refreshDossier: async (incidentKey) => {
      try {
        const job = await repo.getLatestCollectedJobForIncident(incidentKey);
        if (job) await scoreQueue.push({ body: { jobId: job.id } });
      } catch (err) {
        console.warn('dossier refresh not queued', { incidentKey, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
      }
    },
    now: Date.now,
  };
}
