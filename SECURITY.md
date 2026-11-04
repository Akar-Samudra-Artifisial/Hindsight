# Security Policy

Hindsight is provided by Bayu Trisnapati. This policy explains how to report a security vulnerability and how reports are handled.

## Scope

This policy covers:

- The **Hindsight** Forge app for Jira and Confluence, as distributed through its Atlassian Marketplace listing (vendor: Bayu Trisnapati).
- The source code in this repository.

Vulnerabilities in Atlassian products or the Forge platform itself are out of scope; please report those to Atlassian through its [bug bounty program](https://bugcrowd.com/atlassian).

## Supported versions

Only the **latest production version** of Hindsight receives security fixes. Forge apps are updated centrally, so every installation runs the latest version once a fix is deployed (a major version that adds permissions may need an admin to approve the update).

## Reporting a vulnerability

Please report vulnerabilities privately through one of these channels:

- **Support portal:** https://bayutrisnapati.atlassian.net/servicedesk/customer/portals (start the summary with `[Security]`)
- **Email:** bayutrisnapati@gmail.com (subject starting with `[Security]`)

**Do not open a public GitHub issue, pull request or discussion for a vulnerability.**

Please include, where possible:

- A description of the issue and its potential impact.
- The affected module or surface (issue panel, global page, admin page, Rovo agent or action, MCP tool, Teamwork Graph connector).
- Steps to reproduce or a proof of concept.
- The Hindsight version (from the Manage apps page) and your site's product setup (for example, Jira Service Management or Jira Software, and Confluence).
- Whether you believe the issue is being actively exploited.

Do not include real customer data in your report. Please test only against sites you own or are authorized to test, and avoid degrading service for other users.

## Response targets

Hindsight is maintained by a single developer. Targets are in line with the [Atlassian Marketplace Security Bug Fix Policy](https://developer.atlassian.com/platform/marketplace/security-bug-fix-policy/):

| Step | Target |
| --- | --- |
| Acknowledge the report | Within 3 business days |
| Fix a **critical** issue | Within 4 weeks |
| Fix a **high** issue | Within 6 weeks |
| Fix a **medium** issue | Within 8 weeks |
| Fix a **low** issue | Within 25 weeks |

Severity is assessed with CVSS. You will be kept informed of progress and told when a fix is released. With your consent, you will be credited once the fix is available. Please allow a fix to be released before any public disclosure.

## Security design

- **Runs on Atlassian.** Hindsight runs entirely on Atlassian Forge. The manifest declares no external fetch or egress permissions, and the app has no remote backend and calls no third-party services.
- **Data stays in your Atlassian cloud.** Analysis results, routes, alerts and settings are stored in Forge SQL, hosted by Atlassian and separated per installation. The developer has no access to your site's data.
- **LLM through Forge LLM only.** Candidate signals are scored by Claude models hosted by Atlassian through Forge LLM. Content is not sent to any external LLM provider.
- **Permission checks.** Quotes, titles and links are shown only to users who can open the source artifact, verified with `asUser` calls. Rovo actions and MCP tools apply the same checks.
- **Least-privilege scopes.** Each scope in `manifest.yml` is documented with the reason it is needed. Adding a scope requires a major version that site admins must approve.
- **No stored secrets.** Hindsight stores no API tokens, passwords or credentials; authentication is handled by the Forge platform.
- **Dependency scanning.** Dependencies are pinned through `package-lock.json` and checked with `npm audit` before releases.
- **Maintainer account security.** Multi-factor authentication is enabled on the maintainer's Atlassian, GitHub and email accounts. Development machines use full-disk encryption, and backups are encrypted.

## Related documents

- [Privacy Policy](docs/PRIVACY.md)
- [Terms of Service](docs/TERMS.md)
