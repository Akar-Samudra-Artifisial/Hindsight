import { extractKeywords, parseKeywords, type Keyword } from './keywords';

/** Analysis scope (pure): which service, projects, spaces, keywords and time windows a job covers. */

const DAY_MS = 86_400_000;
/** JQL/CQL dates are day precision in the site time zone; widen the real query window by a day on each side. */
export const QUERY_SLACK_DAYS = 1;

export type ServiceSource = 'property' | 'component' | 'manual';

export interface ScopeMapping {
  serviceKey: string;
  jiraProjectKeys: readonly string[];
  jiraComponentNames: readonly string[];
  confluenceSpaceKeys: readonly string[];
  aliases: readonly string[];
}

export interface ScopeIncident {
  issueKey: string;
  projectKey: string;
  summary: string;
  description: string;
  componentNames: readonly string[];
  /** Real Jira creation time. */
  startedAt: string;
  /** Demo scenario time, when seeded. */
  scenarioStartedAt: string | null;
  /** `serviceKey` from the issue property `hindsight` (demo seed). */
  propertyServiceKey: string | null;
  /** `incidents.service_key` chosen manually in the panel. */
  manualServiceKey: string | null;
}

export interface ScopeSettings {
  excludedProjectKeys: readonly string[];
  excludedSpaceKeys: readonly string[];
}

/** Compact service index so collect can tag events with a service without reading mappings again. */
export interface ScopeService {
  serviceKey: string;
  projectKeys: string[];
  componentNames: string[];
  spaceKeys: string[];
}

export interface Scope {
  incidentKey: string;
  serviceKey: string | null;
  serviceSource: ServiceSource | null;
  /** True when no service could be resolved: every mapping is searched and the UI warns about a limited scope. */
  limited: boolean;
  jiraProjectKeys: string[];
  confluenceSpaceKeys: string[];
  /** Components of the incident and of its service; an event with one of them gets the component points. */
  componentNames: string[];
  keywords: Keyword[];
  services: ScopeService[];
  windowDays: number;
  /** Real-time bounds for JQL/CQL (`created`/`lastmodified` cannot be backdated). */
  queryFrom: string;
  queryTo: string;
  /** Effective-time window `[windowFrom, windowTo)`; `windowTo` is the effective incident start. */
  windowFrom: string;
  windowTo: string;
}

const uniqSorted = (items: Iterable<string>): string[] => [...new Set(items)].filter((s) => s !== '').sort();
const lower = (s: string) => s.trim().toLowerCase();

function resolveService(incident: ScopeIncident, mappings: readonly ScopeMapping[]): { mapping: ScopeMapping; source: ServiceSource } | undefined {
  const byKey = (key: string | null) => (key ? mappings.find((m) => m.serviceKey === key) : undefined);
  const fromProperty = byKey(incident.propertyServiceKey);
  if (fromProperty) return { mapping: fromProperty, source: 'property' };
  const components = new Set(incident.componentNames.map(lower));
  const fromComponent = mappings.find((m) => m.jiraComponentNames.some((c) => components.has(lower(c))));
  if (fromComponent) return { mapping: fromComponent, source: 'component' };
  const manual = byKey(incident.manualServiceKey);
  if (manual) return { mapping: manual, source: 'manual' };
  return undefined;
}

export function buildScope(
  incident: ScopeIncident,
  mappings: readonly ScopeMapping[],
  settings: ScopeSettings,
  windowDays: number,
): Scope {
  const resolved = resolveService(incident, mappings);
  const covered = resolved ? [resolved.mapping] : mappings;
  const excludedProjects = new Set(settings.excludedProjectKeys.map((k) => k.toUpperCase()));
  const excludedSpaces = new Set(settings.excludedSpaceKeys);
  // The incident's own project is always searched (earlier tickets in the same service desk), unless excluded.
  const projects = uniqSorted([incident.projectKey, ...covered.flatMap((m) => m.jiraProjectKeys)].map((k) => k.toUpperCase())).filter(
    (k) => !excludedProjects.has(k),
  );
  const spaces = uniqSorted(covered.flatMap((m) => m.confluenceSpaceKeys)).filter((k) => !excludedSpaces.has(k));

  const realStart = new Date(incident.startedAt).getTime();
  const effectiveStart = new Date(incident.scenarioStartedAt ?? incident.startedAt).getTime();
  if (!Number.isFinite(realStart) || !Number.isFinite(effectiveStart)) throw new Error(`Incident ${incident.issueKey} has no valid start time`);
  const days = Math.trunc(windowDays);

  return {
    incidentKey: incident.issueKey,
    serviceKey: resolved?.mapping.serviceKey ?? null,
    serviceSource: resolved?.source ?? null,
    limited: resolved === undefined,
    jiraProjectKeys: projects,
    confluenceSpaceKeys: spaces,
    componentNames: uniqSorted([...incident.componentNames, ...(resolved?.mapping.jiraComponentNames ?? [])]),
    keywords: extractKeywords({ summary: incident.summary, description: incident.description, aliases: resolved?.mapping.aliases ?? [] }),
    services: mappings.map((m) => ({
      serviceKey: m.serviceKey,
      projectKeys: uniqSorted(m.jiraProjectKeys.map((k) => k.toUpperCase())),
      componentNames: uniqSorted(m.jiraComponentNames),
      spaceKeys: uniqSorted(m.confluenceSpaceKeys),
    })),
    windowDays: days,
    queryFrom: new Date(realStart - (days + QUERY_SLACK_DAYS) * DAY_MS).toISOString(),
    queryTo: new Date(realStart + QUERY_SLACK_DAYS * DAY_MS).toISOString(),
    windowFrom: new Date(effectiveStart - days * DAY_MS).toISOString(),
    windowTo: new Date(effectiveStart).toISOString(),
  };
}

/**
 * Service of a collected event: a mapped component wins, then a project or space that belongs to exactly one
 * service. Ambiguous or unmapped → null.
 */
export function eventServiceKey(
  services: readonly ScopeService[],
  ev: { projectKey?: string | null; spaceKey?: string | null; componentNames?: readonly string[] | null },
): string | null {
  const components = new Set((ev.componentNames ?? []).map(lower));
  const byComponent = services.filter((s) => s.componentNames.some((c) => components.has(lower(c))));
  if (byComponent.length === 1) return byComponent[0]?.serviceKey ?? null;
  const project = ev.projectKey?.toUpperCase();
  const byContainer = services.filter(
    (s) => (project !== undefined && s.projectKeys.includes(project)) || (ev.spaceKey ? s.spaceKeys.includes(ev.spaceKey) : false),
  );
  return byContainer.length === 1 ? (byContainer[0]?.serviceKey ?? null) : null;
}

const stringArray = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : []);

/** Reads `analysis_jobs.scope_json` back; throws when the stored shape is not a scope. */
export function parseScope(raw: unknown): Scope {
  if (!raw || typeof raw !== 'object') throw new Error('Job scope is missing');
  const s = raw as Record<string, unknown>;
  const text = (k: string): string => {
    const v = s[k];
    if (typeof v !== 'string' || v === '') throw new Error(`Job scope field ${k} is missing`);
    return v;
  };
  const services = Array.isArray(s['services'])
    ? (s['services'] as unknown[]).flatMap((x) => {
        if (!x || typeof x !== 'object') return [];
        const o = x as Record<string, unknown>;
        if (typeof o['serviceKey'] !== 'string') return [];
        return [
          {
            serviceKey: o['serviceKey'],
            projectKeys: stringArray(o['projectKeys']),
            componentNames: stringArray(o['componentNames']),
            spaceKeys: stringArray(o['spaceKeys']),
          },
        ];
      })
    : [];
  const source = s['serviceSource'];
  return {
    incidentKey: text('incidentKey'),
    serviceKey: typeof s['serviceKey'] === 'string' ? s['serviceKey'] : null,
    serviceSource: source === 'property' || source === 'component' || source === 'manual' ? source : null,
    limited: s['limited'] === true,
    jiraProjectKeys: stringArray(s['jiraProjectKeys']),
    confluenceSpaceKeys: stringArray(s['confluenceSpaceKeys']),
    componentNames: stringArray(s['componentNames']),
    keywords: parseKeywords(s['keywords']),
    services,
    windowDays: typeof s['windowDays'] === 'number' ? s['windowDays'] : 0,
    queryFrom: text('queryFrom'),
    queryTo: text('queryTo'),
    windowFrom: text('windowFrom'),
    windowTo: text('windowTo'),
  };
}
