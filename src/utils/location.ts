import { createLogger } from '../log';
import { fetchWithTimeout, getErrorMessage, readTextUpTo } from '../utils';

const log = createLogger('Location');

const CF_TRACE_URL = 'https://cloudflare.com/cdn-cgi/trace';
const LOOKUP_TIMEOUT_MS = 3000;
/** The trace is about 250 bytes. */
const TRACE_MAX_BYTES = 4096;
const RETRY_AFTER_MS = 60_000;
const UNKNOWN = 'UNKNOWN';

export interface LocationDeps {
  readonly lookup: () => Promise<string>;
  readonly now: () => number;
}

/** The same colo format the Worker records. */
export async function lookupCloudflareColo(fetcher = fetchWithTimeout): Promise<string> {
  const res = await fetcher(CF_TRACE_URL, { timeout: LOOKUP_TIMEOUT_MS });
  const colo = /^colo=(.+)$/m.exec(await readTextUpTo(res, TRACE_MAX_BYTES))?.[1];
  if (!colo) throw new Error('The Cloudflare trace has no colo line');
  return colo;
}

/** Never blocks: answers UNKNOWN until a lookup succeeds. */
export function createLocation(
  configured: string | undefined,
  deps: LocationDeps = { lookup: lookupCloudflareColo, now: Date.now },
): () => string {
  if (configured) {
    log.info('Manually set', { location: configured });
    return () => configured;
  }

  let found: string | undefined;
  let lastAttempt = 0;

  const attempt = () => {
    lastAttempt = deps.now();
    deps.lookup().then(
      (colo) => {
        found = colo;
        log.info('Detected via CF trace', { location: colo });
      },
      (error: unknown) => {
        log.warn('Could not detect location', { error: getErrorMessage(error) });
      },
    );
  };

  attempt();
  return () => {
    if (found === undefined && deps.now() - lastAttempt >= RETRY_AFTER_MS) {
      attempt();
    }
    return found ?? UNKNOWN;
  };
}
