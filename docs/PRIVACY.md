# Hindsight Privacy Policy

Effective date: 3 November 2026

Hindsight is an Atlassian Forge app for Jira Service Management, Jira and Confluence, built by Akar Samudra Artifisial as an entry to Atlassian Codegeist 2026. For a past incident, it looks back at the work items, comments and pages created before the incident, finds early signals that already pointed to the problem, and shows where those signals stopped travelling. Approved routes can then forward similar signals to the right team in the future.

This policy explains what data the app handles. Hindsight is in early development: this policy describes the app as designed, and it will be updated if the implementation differs. Items marked "planned" are optional features that may not be released.

## Where the app runs

Hindsight runs entirely on Atlassian's Forge platform and is designed to be eligible for "Runs on Atlassian":

- It does not send data to servers operated by the developer or by any third party.
- It makes no network calls outside Atlassian product APIs and Forge services (no egress, no remote backend).
- AI features use Forge LLM: a Claude model hosted by Atlassian inside the Forge platform. Content sent to the model stays within Atlassian and is not used by the developer for model training.

The developer has no access to the data in your site.

## Data the app reads

Within the site where it is installed, and only as far as the permissions you approve at install time allow:

- **Jira Service Management:** incidents and customer requests (service affected, start and end time, severity, responder team) to define the scope of an analysis.
- **Jira:** work items, their comments, components, labels and watchers in the projects mapped to the affected service.
- **Confluence:** pages, page comments, labels and spaces mapped to the affected service.
- **Teamwork Graph (read):** page contributors, team membership and relations between people, teams and work items, used to compute the "reach map" (whether a signal provably reached the responder team).

Admins can exclude specific Jira projects or Confluence spaces from scanning.

## Data the app stores

Data the app persists is kept in Atlassian-hosted Forge SQL, separate for each installation. Hindsight stores references and short quotes, not full copies of your content:

- **Incidents:** issue key, affected service, start and end time, severity, responder team.
- **Events:** type, time, link to the source artifact, service or component, and the Atlassian account ID of the author.
- **Signal candidates:** a reference to an event, a filter score and the reason it passed filtering.
- **Signals:** the exact short quote, signal type, confidence, status (proposed, confirmed, rejected) and number of days before the incident.
- **Reach paths:** the steps from a signal to the responder team (artifact, team, role), the number of steps and where the signal stopped.
- **Routes:** source scope (space, project, label, component, keywords), target team, reason and originating incident. Routes become active only after a person approves them.
- **Patterns and alerts:** summaries and keywords from confirmed signals, and alerts raised for new artifacts, including "useful / not useful" feedback.
- **Metrics:** team-level metrics derived from the data above, computed when they are read.
- **Decisions:** confirm or reject decisions on signals, with time, the role of the person who decided (not their name) and an optional reason.
- **Configuration and job status:** service mappings, settings, and analysis progress (counts, errors, prompt version). These contain no artifact content.

The app does not store names or email addresses. It displays names that Atlassian returns only when a user opens the original artifact, under the permissions that already apply in the Atlassian product.

## Retention

- Rejected signal candidates are deleted automatically by a daily job, 30 days after the post-incident review (PIR) is closed.
- Other data is kept while the app is installed, so that confirmed signals, routes and metrics remain available for later incidents.
- Application logs contain only IDs and counts, never artifact content or names.

## Data the app writes to your site

- **Sentinel suggestions:** when an approved route matches a new artifact, Hindsight adds a comment mentioning the target team, or adds them as watchers.
- **Post-incident review section (planned):** on request and after confirmation, Hindsight adds an "Early signals" section to a Confluence PIR page.
- **Agent briefings:** the Rovo agent "Hindsight Investigator" can post a briefing comment on an incident when a user asks it to.
- **Demo data:** only when an admin presses "Load demo data", Hindsight creates a demo project, space, pages and work items for a fictional company.
- **Teamwork Graph (planned, conditional):** if this feature is released and enabled for your site, Hindsight writes a "signal dossier" (short quotes of confirmed signals and links to the incident and source artifacts) and service-to-team ownership to Teamwork Graph through a Forge graph connector. Until then, nothing is written to Teamwork Graph and this data stays in Forge SQL only.

Write actions requested through Rovo always ask the user for confirmation first.

## Permissions are checked per user

Forge functions running as the app can read more than an individual user. Before showing a signal, Hindsight checks, as the viewing user, whether that user can read the source artifact. Signals in artifacts the user cannot access are shown only as a count (for example "1 signal in an artifact you cannot access"), without the quote or link. Rovo actions and planned MCP tools apply the same checks.

## Blameless by design

Hindsight is built for blameless post-incident learning:

- Reports describe teams and roles, not named individuals.
- There are no per-person scores or metrics; the smallest unit of aggregation is a team.
- Language describes paths and missing connections ("the signal stopped in the Platform space"), never individual fault.

## Your choices and rights

- Admins can exclude projects and spaces from scanning at any time.
- Users can reject any proposed signal; rejected candidates are deleted as described under Retention.
- Uninstalling the app removes its Forge SQL data, following Atlassian's Forge data retention rules. Comments, pages and work items that Hindsight created stay in your site until you delete them.
- The app does not sell or share your data, does not use it for advertising and uses no third-party analytics.
- To ask about or request deletion of data, contact us below. Because the developer cannot access your site's data, deletion is done by uninstalling the app or by a site admin.

## Changes

Updates to this policy are published in this file in the public repository, with a new effective date.

## Contact

Questions: bayutrisnapati@gmail.com
