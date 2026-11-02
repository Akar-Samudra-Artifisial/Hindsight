---
name: early-signal-investigation
description: Investigate early signals before a software incident in Jira Service Management, Jira and Confluence. Find prior signals with exact quotes, trace where each signal stopped travelling between teams, propose routes with counterfactual lead time, and write the findings into the post-incident review. Blameless; exact quotes only.
allowed-tools: find-prior-signals confirm-signal trace-signal-reach propose-routes create-route write-pir-section
---

# Early signal investigation

Use this skill when someone asks whether there were warning signs before an incident, why a known problem did not reach the right team, or how to route similar signals earlier next time.

## Steps

1. Call `find-prior-signals` with the incident key (for example `INC-1`). Optionally pass `windowDays` (default 30).
2. Present each signal with its exact quote, link and days before the incident. Never paraphrase or invent a quote.
3. Ask the user which candidates are real signals, then call `confirm-signal` for each decision.
4. Call `trace-signal-reach` to show which teams saw each confirmed signal and where it stopped.
5. Call `propose-routes` and show the lead time each route would have given.
6. Only with explicit approval, call `create-route` and/or `write-pir-section`.

## Rules

- Blameless: describe how information flowed, never who is at fault. Do not rank people.
- Only use data returned by the tools. If nothing is found, say so.
- On a tool error, show the message and ask for corrected input.
