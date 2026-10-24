/**
 * FREE-02 fixtures: a fake model client for the isolated UI fixture and founder preview. It never reaches a network or
 * a real model: it answers by the kind of request (plan / review / unblock) with fixed synthetic JSON. A brief containing
 * MALFORMED gets prose back, so the needs-attention path can be shown.
 */
import type { ChatFn } from '../src/server/chief.js';

export const FIXTURE_PLAN = JSON.stringify({
  summary: 'API first, then the form and the guide side by side, then an accessibility pass.',
  items: [
    { title: 'Build the booking API', prompt: 'Implement availability and booking endpoints with tests. Synthetic fixture.', phase: 'build', role: 'backend_engineer', parallel: false, dependsOn: [] },
    { title: 'Build the booking form', prompt: 'Implement the accessible booking form against the API. Synthetic fixture.', phase: 'build', role: 'frontend_engineer', parallel: false, dependsOn: [1] },
    { title: 'Write the client guide', prompt: 'Write a one-page guide for clinic staff. Synthetic fixture.', phase: 'build', role: 'writer', parallel: true, dependsOn: [1] },
    { title: 'Accessibility test pass', prompt: 'Test with keyboard and a screen reader; report issues. Synthetic fixture.', phase: 'testing', role: 'qa_tester', parallel: false, dependsOn: [2, 3] },
  ],
});
const REVIEW = JSON.stringify({ recommendation: 'needs_changes', summary: 'The worker finished its turn, but no diff or pull request is available to check, so the API work cannot be confirmed from this evidence.', concerns: ['Open a pull request so the change can be reviewed', 'Confirm double-booking of one slot is tested'] });
const PROPOSAL = JSON.stringify({ proposal: 'The form task failed twice on the same missing environment variable. Merge it with the API item and give it the example .env.sample, or remove it and re-plan the form after the API is accepted.' });

export const fixtureChat: ChatFn = async (p, messages) => {
  const system = messages[0]?.content ?? '';
  const user = messages[1]?.content ?? '';
  const text = /planning assistant/.test(system) ? (user.includes('MALFORMED') ? 'Sure! First we build it, then we test it.' : FIXTURE_PLAN)
    : /review finished work/.test(system) ? REVIEW : PROPOSAL;
  return { text, model: p.model, usage: { input: 900, output: 300 }, cost: { usd: 0, kind: 'local', label: 'US$0 · local model' } };
};
