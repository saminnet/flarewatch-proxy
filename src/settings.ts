const DEFAULT_PORT = 3000;
const MAX_PORT = 65_535;
const MIN_TOKEN_LENGTH = 16;

export type Settings = {
  authToken: string;
  previousAuthToken: string | undefined;
  location: string | undefined;
  port: number;
};

function readPort(raw: string | undefined) {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return port >= 1 && port <= MAX_PORT ? port : undefined;
}

function lengthError(name: string, token: string | undefined) {
  return token !== undefined && token.length < MIN_TOKEN_LENGTH
    ? { error: `${name} must be at least ${MIN_TOKEN_LENGTH} characters` }
    : undefined;
}

export function readSettings(env: NodeJS.ProcessEnv): Settings | { error: string } {
  const authToken = env['FLAREWATCH_PROXY_TOKEN']?.trim();
  if (!authToken) return { error: 'FLAREWATCH_PROXY_TOKEN is required' };

  const previousAuthToken = env['FLAREWATCH_PROXY_TOKEN_PREVIOUS']?.trim() || undefined;
  const tokenError =
    lengthError('FLAREWATCH_PROXY_TOKEN', authToken) ??
    lengthError('FLAREWATCH_PROXY_TOKEN_PREVIOUS', previousAuthToken);
  if (tokenError) return tokenError;

  const port = readPort(env['PORT']);
  if (port === undefined) return { error: `PORT must be a whole number from 1 to ${MAX_PORT}` };

  const location = env['FLAREWATCH_PROXY_LOCATION']?.trim() || undefined;

  return { authToken, location, port, previousAuthToken };
}
