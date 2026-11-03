<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hindsight-logo-wordmark-white.svg">
  <img src="docs/assets/hindsight-logo-wordmark.svg" alt="Hindsight" width="260">
</picture>

# Hindsight

Hindsight is an Atlassian Forge app for Jira Service Management, Jira and Confluence. For a past incident, it looks back at the comments, tickets and pages created before the incident, finds the early signals that already pointed to the problem, and shows where they stopped travelling. Routes approved by people then help similar signals reach the right team next time.

Built for Atlassian Codegeist 2026 (Apps for Software Teams). Runs on Atlassian: no external servers, no third-party AI.

## Status

Early development. Features, installation and configuration instructions will be added as they are built.

## Installation

To be added.

## Development

Requires Node.js 22 or 24 and the [Forge CLI](https://developer.atlassian.com/platform/forge/getting-started/).

```sh
npm install
npm test           # Vitest unit tests
npm run build      # typecheck + build the Custom UI views into static/<view>/build
npm run lint       # forge lint (needs a registered app id in manifest.yml)
npm run deploy     # build the UI and forge deploy
```

## Privacy and terms

- [Privacy Policy](docs/PRIVACY.md)
- [Terms of Service](docs/TERMS.md)

## License

[MIT](LICENSE)
