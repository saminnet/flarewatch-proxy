import { serve } from '@hono/node-server';
import { createProxy } from './app';
import { createLogger } from './log';
import { readSettings } from './settings';

const log = createLogger('Proxy');

const settings = readSettings(process.env);

if ('error' in settings) {
  log.error(settings.error);
  process.exit(1);
}

const { authToken, location, port, previousAuthToken } = settings;

const app = createProxy({ authToken, location, previousAuthToken });

log.info('Starting', {
  location: location ?? 'auto-detect',
  port,
});

serve({
  fetch: app.fetch,
  port,
});
