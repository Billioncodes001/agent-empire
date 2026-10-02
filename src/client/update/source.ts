/**
 * Finds the newest signed channel file for a channel.
 *
 *   stable  github.com/<repo>/releases/latest/download/channel-stable.json (+ .sig)
 *   beta    the newest pre-release carrying channel-beta.json, found through the api.github.com releases listing,
 *           compared with stable: a beta player also gets a newer stable release.
 *
 * The listing is fetched with If-None-Match against a cached copy (a 304 is not counted by GitHub's rate limit); when
 * GitHub answers 403/429 for the rate limit the cached listing is used and the next attempt waits for the reset.
 * Every file is verified before it is parsed (verify.ts); a file that fails is skipped with its reason recorded.
 */
import { channelUrls, newestPrereleaseTag, RELEASES_API, type Channel, type ChannelFile } from './channel';
import { compareSemver } from './semver';
import { verifyChannel } from './verify';
import type { FetchResult } from './bridge';

export type Fetcher = (url: string, etag?: string) => Promise<FetchResult>;
export interface KeyValue {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const LISTING_KEY = 'agent-empire.update.releases';

export class SourceError extends Error {
  constructor(message: string, readonly code: 'offline' | 'rate_limited' | 'not_found' | 'invalid' | 'signature') {
    super(message);
    this.name = 'SourceError';
  }
}

export interface FetchedChannel {
  file: ChannelFile;
  /** Where it came from: 'latest' or the pre-release tag. */
  from: string;
}

async function get(fetcher: Fetcher, url: string, etag?: string): Promise<FetchResult> {
  try {
    return await fetcher(url, etag);
  } catch (error) {
    throw new SourceError(error instanceof Error ? error.message : 'Can’t reach GitHub.', 'offline');
  }
}

async function signed(fetcher: Fetcher, channel: Channel, tag: string | undefined, publicKey?: string): Promise<FetchedChannel | null> {
  const urls = channelUrls(channel, tag);
  const [json, sig] = await Promise.all([get(fetcher, urls.json), get(fetcher, urls.sig)]);
  if (json.status === 404 || sig.status === 404) return null; // no release on this channel yet
  if (json.status !== 200 || sig.status !== 200) throw new SourceError(`GitHub answered ${json.status !== 200 ? json.status : sig.status} for the update channel.`, json.status === 429 || json.status === 403 ? 'rate_limited' : 'offline');
  try {
    return { file: await verifyChannel(json.body, sig.body, channel, publicKey), from: tag ?? 'latest' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid';
    throw new SourceError(message, /signature/.test(message) ? 'signature' : 'invalid');
  }
}

/** The newest pre-release tag with beta channel files, using (and refreshing) the cached listing. */
async function betaTag(fetcher: Fetcher, cache: KeyValue | null, now: number): Promise<string | null> {
  let cached: { etag: string | null; body: string; retryAt?: number } | null = null;
  try {
    cached = JSON.parse(cache?.get(LISTING_KEY) ?? 'null');
  } catch {}
  const parse = (body: string) => {
    try {
      return newestPrereleaseTag(JSON.parse(body), compareSemver);
    } catch {
      return null;
    }
  };
  if (cached?.retryAt && now < cached.retryAt) return parse(cached.body);
  const r = await get(fetcher, RELEASES_API, cached?.etag ?? undefined);
  if (r.status === 304 && cached) return parse(cached.body);
  if (r.status === 403 || r.status === 429) {
    if (cache && cached) cache.set(LISTING_KEY, JSON.stringify({ ...cached, retryAt: now + 30 * 60_000 }));
    if (cached) return parse(cached.body);
    throw new SourceError('GitHub’s rate limit was reached. Updates are checked again later.', 'rate_limited');
  }
  if (r.status !== 200) throw new SourceError(`GitHub answered ${r.status} for the releases list.`, r.status === 404 ? 'not_found' : 'offline');
  if (r.body.length > 2 * 1024 * 1024) throw new SourceError('The releases list is too large.', 'invalid');
  try {
    cache?.set(LISTING_KEY, JSON.stringify({ etag: r.etag, body: r.body }));
  } catch {}
  return parse(r.body);
}

/** The newest verified channel file for `channel`, or null when the channel has no release yet. */
export async function fetchChannel(channel: Channel, fetcher: Fetcher, opts: { cache?: KeyValue | null; now?: number; publicKey?: string } = {}): Promise<FetchedChannel | null> {
  if (channel === 'stable') return signed(fetcher, 'stable', undefined, opts.publicKey);
  // Beta: a problem with the stable file doesn't hide a valid pre-release (and the reverse).
  const [s, b] = await Promise.allSettled([
    signed(fetcher, 'stable', undefined, opts.publicKey),
    betaTag(fetcher, opts.cache ?? null, opts.now ?? Date.now()).then((tag) => (tag ? signed(fetcher, 'beta', tag, opts.publicKey) : null)),
  ]);
  if (s.status === 'rejected' && b.status === 'rejected') throw b.reason;
  const stable = s.status === 'fulfilled' ? s.value : null;
  const beta = b.status === 'fulfilled' ? b.value : null;
  if (!beta) {
    if (s.status === 'rejected') throw s.reason;
    if (!stable && b.status === 'rejected') throw b.reason;
    return stable;
  }
  if (!stable) return beta;
  return compareSemver(beta.file.version, stable.file.version) > 0 ? beta : stable;
}
