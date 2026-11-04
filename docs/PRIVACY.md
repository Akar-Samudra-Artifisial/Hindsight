# Hindsight Privacy Policy

Last updated: 4 November 2026

Hindsight is an Atlassian Forge app for Jira (including Jira Service Management) and Confluence, provided by Bayu Trisnapati (individual Marketplace vendor, publishing the source as part of Akar Samudra Artifisial on GitHub) as an entry to Atlassian Codegeist 2026. For a past incident, it looks back at the work items, comments and pages created before the incident, finds early signals that already pointed to the problem, and shows where those signals stopped travelling. Routes approved by people then watch for similar signals and alert the right team in the future.

This policy explains what data the app reads, stores and writes, and who can see it.

## Where the app runs

Hindsight runs entirely on Atlassian's Forge platform and is eligible for "Runs on Atlassian":

- It does not send data to servers operated by the developer or by any third party.
- It makes no network calls outside Atlassian product APIs and Forge services (no egress, no remote backend).
- AI scoring uses Forge LLM: Claude models (Claude Haiku and Claude Sonnet) hosted by Atlassian inside the Forge platform. Content sent to the model stays within Atlassian and is not used by the developer for model training.

The developer has no access to the data in your site.

## Data the app reads

Within the site where it is installed, and only as far as the permissions you approve at install time allow:

- **Jira and Jira Service Management:** the incident (key, affected service, start time), and work items, requests and their comments, components, labels and watchers in the projects mapped to the affected service.
- **Confluence:** pages and page comments in the spaces mapped to the affected service, and the people who edited a page.
- **Teamwork Graph (read):** team membership of the people who touched a signal's artifact, used to compute the "reach map" (whether a signal provably reached the responder team before the incident).

Only projects and spaces listed in the service mappings on the Hindsight setup page (plus the incident's own project) are scanned. An admin controls scope by editing or removing those mappings.

## Data the app stores

Data the app persists is kept in Atlassian-hosted Forge SQL, separate for each installation. Hindsight stores references and short excerpts, not full copies of your content:

- **Incidents:** issue key and project, the incident summary (its title), severity, affected service, start and resolution time, the responder team (team ID and team name), and the keywords used to search for signals.
- **Events:** for each work item, request, comment or page in scope: type, time, a reference and link to the source artifact, its title, project or space, component names and labels, workflow status and resolution, a hash and the length of its text (not the text itself), and the Atlassian account ID of the author (used only to compute reach).
- **Signal candidates:** a reference to an event, a filter score, the reason it passed filtering, and an excerpt of the artifact text of at most 2,000 characters, which is what the AI model reads.
- **Signals:** a verbatim quote of at most 300 characters taken from the excerpt, signal type, confidence, a short reason (account IDs, emails and @mentions are removed), status (proposed, confirmed, rejected) and the number of days before the incident.
- **Decisions:** confirm, reject and undo decisions on signals and route approvals, with time and the Atlassian account ID of the person who decided. This ID is kept for audit only and is never shown in the app, sent to Rovo or exposed over MCP.
- **Reach paths:** for each confirmed signal, the teams and roles that touched it, the number of steps and where it stopped. No account IDs are stored here.
- **Routes:** source (space, project, component or label), keywords, target team, estimated days saved, status, the originating incident, and the Atlassian account ID of the person who approved or dismissed the route (audit only, never shown in the app, sent to Rovo or exposed over MCP). Routes become active only after a person approves them.
- **Alerts:** for each Sentinel match, the route, a reference, link and title of the artifact, the matched keywords, the target team (team ID and team name), the ID of the posted comment, status and optional "Useful / Not useful" feedback. No account IDs are stored here.
- **Score cache:** for the demo incident only, the AI verdict per artifact (including the quote and short reason), so that re-running the demo gives the same result.
- **Configuration and job status:** service mappings (projects, components, spaces, aliases, owner team ID and team name), settings, the Teamwork Graph connection ID and name, analysis progress (counts, errors, model and prompt version, and the Atlassian account ID of the person who started the analysis), and records of demo artifacts created by the app. These contain no artifact content.

The app does not store names or email addresses of people; it stores team names only. Names are shown only when Atlassian returns them to a user who can already see the original artifact.

## Retention

- Data is kept while the app is installed, so that confirmed signals, routes and metrics remain available for later incidents.
- Automatic deletion of rejected signal candidates is not implemented yet. A daily retention job is registered but does not delete data at this time; this policy will be updated when it does.
- "Reset to showcase" and "Remove demo data" on the setup page delete the analysis, reach, route, alert and score cache data of the demo incident.
- Application logs contain only IDs, counts and statuses, never artifact content or names.

## Data the app writes to your site

- **Sentinel alerts:** when an Active route matches a new Jira work item or comment, or a new or updated Confluence page or comment, Hindsight posts one comment as the app: "[Hindsight Sentinel] Heads-up for **team name**", linking the past incident key. The comment names the team, never a person, and does not repeat the matched keywords. In Jira Service Management projects it is posted as an internal comment. Alerts are capped per team per week and per day.
- **Demo data:** only when an admin presses "Load demo data", Hindsight creates demo projects (`INC`, `PAY`), a Confluence space (`PLAT`), and pages, work items and comments for a fictional company. "Stamp demo data" adds a "Reviewed by" note to a demo page and adds the admin as a watcher of a few demo work items. "Post a new provider notice" adds a demo comment, as the admin, to a demo page. "Remove demo data" deletes the work items and pages the app created; projects and the space stay.
- **Teamwork Graph (write):** after an organization admin connects the "Hindsight signals" connector in Atlassian Administration, Hindsight writes a "signal dossier" document per analysed incident ("Early signals for <incident key>") through a Forge graph connector. The dossier contains only counts, day gaps, reach numbers and the incident key; it contains no quotes, artifact titles, names of people or team names. It is visible to everyone in the organization only for the demo incident, or for all incidents if an admin sets `dossier_all_incidents` to true (default false). "Remove demo data" and disconnecting the connector remove the dossiers. Without a connection, nothing is written to Teamwork Graph.

Write actions requested through Rovo (confirming a signal, approving a route) always show Rovo's review form to the user first.

## Rovo agent and MCP

- **Rovo:** the "Hindsight Investigator" agent and the `early-signal-investigation` skill call the same actions as the issue panel, as the user who is chatting, and return only what that user may see.
- **MCP:** Hindsight exposes three read-only tools (`find-prior-signals`, `trace-signal-reach`, `propose-routes`) through Atlassian's MCP endpoint. They are available only after an organization admin turns on "Enable tools" for Hindsight in Atlassian Administration. Each MCP client user signs in with OAuth through Atlassian, and the tools return only data that user is allowed to see. No write action is exposed over MCP.

## Permissions are checked per user

Forge functions running as the app can read more than an individual user. Before showing a signal, Hindsight checks, as the viewing user, whether that user can read the source artifact. Signals in artifacts the user cannot access are shown only as a count, without the quote, title or link. Rovo actions and MCP tools apply the same checks. Setup actions are available only to Jira administrators.

## Blameless by design

Hindsight is built for blameless post-incident learning:

- Reports describe teams and roles, not named individuals.
- There are no per-person scores or metrics; the smallest unit of aggregation is a team.
- Language describes paths and missing connections ("Stopped at Arkana Platform · 1 missing link to Arkana Payments"), never individual fault.

## Your choices and rights

- Admins control which projects and spaces are scanned through the service mappings.
- Users can reject any proposed signal.
- Admins can pause any route, and can choose not to connect the Teamwork Graph connector or not to enable MCP tools.
- Uninstalling the app removes its Forge SQL data, following Atlassian's Forge data retention rules. Comments, pages and work items that Hindsight created stay in your site until you delete them.
- The app does not sell or share your data, does not use it for advertising and uses no third-party analytics.
- To ask about or request deletion of data, contact us below. Because the developer cannot access your site's data, deletion is done by uninstalling the app or by a site admin.

## Changes

Updates to this policy are published in this file in the public repository, with a new "Last updated" date.

## Contact

Hindsight is provided by Bayu Trisnapati.

- Email: bayutrisnapati@gmail.com
- Support portal: https://bayutrisnapati.atlassian.net/servicedesk/customer/portals
