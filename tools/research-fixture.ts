/** ORG-05 synthetic research reports for the isolated UI fixture and founder preview. No worker, network or model. */
import { parseArtifact } from '../src/server/research-artifact.js';
import { parseResearchReport } from '../src/server/research.js';

export const SYNTHETIC_QUESTION = 'Can we offer appointment booking for dental practices?';

export const SYNTHETIC_REPORT = `---
question: ${SYNTHETIC_QUESTION}
feasibility: partial
confidence: medium
---
# Synthetic fixture report

## Findings
- Fixture claim: practices already book online through their practice software (https://example.com/fixture/booking-survey).
- Fixture claim: the common practice systems publish a scheduling API, see https://example.org/fixture/api-docs.
- Fixture claim: reminder messages reduce missed appointments (https://example.net/fixture/no-show-study).

## What we can do now
Build a booking page that writes to a test calendar, with accessible forms and email confirmations.

## What we can't do yet and why
We cannot write into a real practice system: we have no sandbox account, and health data needs a compliance review first.

## Proposed tools
| Name | URL | Licence | Enables | Risk |
|---|---|---|---|---|
| Fixture Calendar SDK | https://example.com/fixture/calendar-sdk | MIT | Read and write availability | Vendor lock-in to one calendar format |
| Fixture Reminder Service | https://example.org/fixture/reminders | Commercial | SMS and email reminders | Per-message cost; stores patient phone numbers |
`;

/** A report that fails the source rule, to show the needs-attention state. */
export const UNSOURCED_REPORT = SYNTHETIC_REPORT
  .replace(SYNTHETIC_QUESTION, 'Could we resell cloud GPUs?')
  .replace(/## Findings[\s\S]*?## What/, '## Findings\n- GPUs are popular.\n\n## What');

export function syntheticParsed() {
  const parsed = parseResearchReport(parseArtifact(Buffer.from(SYNTHETIC_REPORT)));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed;
}
