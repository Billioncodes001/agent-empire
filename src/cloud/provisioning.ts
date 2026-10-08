/**
 * Cloud execution provisioning: find or create the Anthropic Managed Agents resources a cloud Empire
 * dispatches to (one agent, one cloud environment), so a fresh Empire can run jobs without the user
 * copying IDs from the Console.
 *
 * Where it runs: in the coordinator (GitHub Actions), with the ANTHROPIC_API_KEY Actions secret. Not
 * on the device: api.anthropic.com answers browser preflights for /v1/agents with 405 and for
 * /v1/environments with "Disallowed CORS origin" (checked 2026-10-01), so a WebView cannot call them,
 * and the key never comes back out of the encrypted secret after setup.
 *
 * What it calls (docs: platform.claude.com/docs/en/managed-agents/agent-setup, /environments,
 * /api/beta/agents/list, /api/beta/environments/list):
 *   GET  /v1/agents?limit=100[&page]          list (archived excluded by default)
 *   POST /v1/agents                            create { name, model, system, tools, description, metadata }
 *   GET  /v1/environments?limit=100[&page]     list (archived excluded by default)
 *   POST /v1/environments                      create { name, description, config, metadata }
 * It never creates a session, sends an event or starts any other paid work. The pricing page bills
 * Managed Agents on session tokens and session runtime only; creating an agent or environment is not
 * a listed charge.
 *
 * Idempotent: an existing resource carrying our metadata marker (or, failing that, our exact name) is
 * reused. A create whose response is lost is found by the next lookup instead of being created twice.
 */
import { safeExecutionError } from '../server/execution-errors.js';
import { PROVIDER_ID } from '../server/execution-validation.js';
import type { AnthropicManaged } from '../server/providers/anthropic-managed.js';
import { DEFAULT_WORKER_MODEL, isWorkerModel, workerAgentBody, workerAgentName, WORKER_ENVIRONMENT, WORKER_MARKER, WORKER_SPEC_VERSION, type OpenAIWorkerModel, type WorkerModel } from './worker-spec.js';

export { DEFAULT_WORKER_MODEL, isWorkerModel, WORKER_AGENT, workerAgentBody, workerAgentName, WORKER_ENVIRONMENT, WORKER_MARKER, WORKER_MODELS, workerModelLabel, WORKER_SPEC_VERSION, type WorkerModel } from './worker-spec.js';

export type ProvisionResult = AnthropicProvisionResult | OpenAIProvisionResult;
export interface AnthropicProvisionResult {
  provider?: 'anthropic';
  agentId: string;
  environmentId: string;
  agentCreated: boolean;
  environmentCreated: boolean;
  model: WorkerModel;
}
/** CLOUD-06 (openai-provisioning.ts): the vault and the GitHub-token credential; no agent or environment is saved. */
export interface OpenAIProvisionResult {
  provider: 'openai';
  vaultId: string;
  credentialId: string;
  vaultCreated: boolean;
  /** `created` the first time; `updated` when an existing credential received the current project token. */
  credential: 'created' | 'updated';
  model: OpenAIWorkerModel;
}

/** User-safe failure. `retryable` is false when only the user can fix it (key, access, a conflicting resource). */
export class ProvisionError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); this.name = 'ProvisionError'; }
}

const MAX_PAGES = 10;
type Kind = 'agent' | 'environment';
type Item = Record<string, any>;

function usable(kind: Kind, item: Item): string | null {
  if (item.archived_at != null) return `The ${kind} is archived.`;
  if (kind === 'agent') {
    if (item.multiagent != null) return 'It has a multiagent roster, which this app does not budget.';
    if (!Array.isArray(item.tools) || !item.tools.some((tool: any) => tool?.type === 'agent_toolset_20260401')) return 'It lacks the Managed Agents built-in toolset.';
  } else {
    if (item.config?.type !== 'cloud') return 'It is not an Anthropic cloud environment.';
    // A reused environment must have the networking this app shows the user, never silently something else.
    const net = item.config?.networking?.type;
    if (net !== WORKER_ENVIRONMENT.config.networking.type) return `Its networking is ${typeof net === 'string' ? `“${net}”` : 'not reported'}, but Agent Empire runs jobs with ${WORKER_ENVIRONMENT.config.networking.type} networking.`;
  }
  return null;
}

async function list(client: AnthropicManaged, kind: Kind, apiKey: string, includeArchived: boolean): Promise<Item[]> {
  const items: Item[] = [];
  let page: string | undefined;
  for (let n = 0; n < MAX_PAGES; n++) {
    const query = new URLSearchParams({ limit: '100' });
    if (includeArchived) query.set('include_archived', 'true');
    if (page) query.set('page', page);
    const response = await client.controlPlane(kind === 'agent' ? `/v1/agents?${query}` : `/v1/environments?${query}`, apiKey);
    if (!Array.isArray(response.data)) throw new ProvisionError(`Anthropic returned an unexpected ${kind} list.`, true);
    items.push(...response.data.filter((item: unknown) => item && typeof item === 'object'));
    const next = response.next_page;
    if (typeof next !== 'string' || !next || next.length > 2048) return items;
    page = next;
  }
  return items;
}

/** Ours: our metadata marker (and, for agents, the model) first, since the user may rename it; otherwise our exact name. */
function pick(kind: Kind, items: Item[], model: WorkerModel): Item | undefined {
  const pattern = kind === 'agent' ? PROVIDER_ID.agent : PROVIDER_ID.environment;
  const marker = kind === 'agent' ? WORKER_MARKER.agent : WORKER_MARKER.environment;
  const name = kind === 'agent' ? workerAgentName(model) : WORKER_ENVIRONMENT.name;
  const valid = items.filter(item => typeof item.id === 'string' && pattern.test(item.id));
  const sameModel = (item: Item) => kind !== 'agent' || modelOf(item) === model;
  const newest = (a: Item, b: Item) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
  return valid.filter(item => item.metadata?.[WORKER_MARKER.key] === marker && sameModel(item)).sort(newest)[0]
    ?? valid.filter(item => item.name === name).sort(newest)[0];
}
const modelOf = (item: Item): unknown => typeof item.model === 'string' ? item.model : item.model?.id;

async function findOrCreate(client: AnthropicManaged, kind: Kind, apiKey: string, model: WorkerModel): Promise<{ id: string; created: boolean }> {
  const label = kind === 'agent' ? `agent “${workerAgentName(model)}”` : `environment “${WORKER_ENVIRONMENT.name}”`;
  const accept = (item: Item, created: boolean) => {
    const itemModel = modelOf(item);
    const problem = usable(kind, item) ?? (kind === 'agent' && itemModel !== model ? `It runs ${typeof itemModel === 'string' ? itemModel : 'an unreported model'}, not ${model}.` : null);
    if (problem) throw new ProvisionError(`Your Anthropic ${label} (${item.id}) can’t be used: ${problem} Fix or rename it in the Claude Console, then ask the coordinator to set up execution again.`, false);
    return { id: item.id as string, created };
  };
  const existing = pick(kind, await list(client, kind, apiKey, false), model);
  if (existing) return accept(existing, false);
  const metadata = kind === 'agent'
    ? { [WORKER_MARKER.key]: WORKER_MARKER.agent, [WORKER_MARKER.model]: model, agent_empire_spec: WORKER_SPEC_VERSION }
    : { [WORKER_MARKER.key]: WORKER_MARKER.environment, agent_empire_spec: WORKER_SPEC_VERSION };
  const body = kind === 'agent' ? { ...workerAgentBody(model), metadata } : { ...WORKER_ENVIRONMENT, metadata };
  try {
    const created = await client.controlPlane(kind === 'agent' ? '/v1/agents' : '/v1/environments', apiKey, 'POST', body);
    const pattern = kind === 'agent' ? PROVIDER_ID.agent : PROVIDER_ID.environment;
    if (typeof created.id !== 'string' || !pattern.test(created.id)) throw new ProvisionError(`Anthropic did not confirm the new ${label}.`, true);
    return accept(created, true);
  } catch (error) {
    if (error instanceof ProvisionError && !error.retryable) throw error;
    // The create may have succeeded (lost response) or raced another run, or an archived resource may
    // hold the unique environment name (409): look again, archived included, before reporting.
    const again = pick(kind, await list(client, kind, apiKey, true), model);
    if (again) return accept(again, false);
    throw error;
  }
}

/** Finds or creates the worker agent and environment. Throws ProvisionError with a user-safe message. */
export async function provisionAnthropicExecution(client: AnthropicManaged, apiKey: string, model: WorkerModel = DEFAULT_WORKER_MODEL): Promise<AnthropicProvisionResult> {
  if (!isWorkerModel(model)) throw new ProvisionError('Unsupported worker model. Choose one under Cloud Empire → Limits.', false);
  if (!apiKey) throw new ProvisionError('The ANTHROPIC_API_KEY Actions secret is missing from the state repository. Run setup again with an Anthropic API key.', false);
  try {
    const agent = await findOrCreate(client, 'agent', apiKey, model);
    const environment = await findOrCreate(client, 'environment', apiKey, model);
    return { agentId: agent.id, environmentId: environment.id, agentCreated: agent.created, environmentCreated: environment.created, model };
  } catch (error) {
    if (error instanceof ProvisionError) throw error;
    const safe = safeExecutionError(error);
    // 401/403 style rejections need the user (key, Managed Agents access); timeouts and 5xx can retry.
    const retryable = ['provider_timeout', 'provider_unavailable'].includes(safe.code) || /HTTP (429|5\d\d)/.test(safe.message);
    throw new ProvisionError(`${safe.message} No agent session was started.`, retryable);
  }
}
