/** CLOUD-06: the setup state machine's provider choice and OpenAI allowance default. No network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, runProvider, type SetupState } from '../src/client/setup/model';

test('setup model (CLOUD-06): run-on choice only matters with both keys; an untouched allowance follows the provider default', () => {
  let s: SetupState = { ...initialState({ step: 'providers', mode: 'cloud' }), github: { login: 'o', token: 't' }, repos: [{ owner: 'o', name: 'r', private: true, defaultBranch: 'main' }] };
  s = reduce(s, { type: 'setProvider', id: 'openai', value: 'sk-proj-' + 'a'.repeat(40) });
  assert.equal(runProvider(s.providers, s.jobProvider), 'openai');
  assert.equal(reduce(s, { type: 'next' }).limits.perJob, '3.00');
  s = reduce(s, { type: 'setProvider', id: 'anthropic', value: 'sk-ant-' + 'a'.repeat(40) });
  assert.equal(runProvider(s.providers, s.jobProvider), 'anthropic', 'both keys: Anthropic by default');
  assert.equal(reduce(s, { type: 'next' }).limits.perJob, '5.00');
  s = reduce(s, { type: 'setJobProvider', id: 'openai' });
  assert.equal(runProvider(s.providers, s.jobProvider), 'openai');
  const typed = reduce({ ...s, limits: { ...s.limits, perJob: '7.50' } }, { type: 'next' });
  assert.equal(typed.limits.perJob, '7.50', 'a typed allowance is never replaced');
});
