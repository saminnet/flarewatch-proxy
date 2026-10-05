import { describe, expect, it } from 'vite-plus/test';
import { readSettings } from '../src/settings';

const TOKEN = 'a-token-of-32-characters-exactly';

describe('readSettings', () => {
  it('reads the token, the location and the port', () => {
    expect(
      readSettings({
        FLAREWATCH_PROXY_LOCATION: 'Home lab',
        FLAREWATCH_PROXY_TOKEN: TOKEN,
        PORT: '8080',
      }),
    ).toEqual({ authToken: TOKEN, location: 'Home lab', port: 8080, previousAuthToken: undefined });
  });

  it('listens on 3000 when PORT is unset or empty', () => {
    expect(readSettings({ FLAREWATCH_PROXY_TOKEN: TOKEN })).toMatchObject({ port: 3000 });
    expect(readSettings({ FLAREWATCH_PROXY_TOKEN: TOKEN, PORT: '' })).toMatchObject({ port: 3000 });
  });

  it.each(['0', '65536', '-1', '80.5', '8080abc', 'http', ' 8080'])('refuses PORT=%j', (port) => {
    expect(readSettings({ FLAREWATCH_PROXY_TOKEN: TOKEN, PORT: port })).toEqual({
      error: 'PORT must be a whole number from 1 to 65535',
    });
  });

  it('accepts the highest port', () => {
    expect(readSettings({ FLAREWATCH_PROXY_TOKEN: TOKEN, PORT: '65535' })).toMatchObject({
      port: 65_535,
    });
  });

  it.each(['', '   '])('finds the location itself when the configured one is %j', (location) => {
    expect(
      readSettings({ FLAREWATCH_PROXY_LOCATION: location, FLAREWATCH_PROXY_TOKEN: TOKEN }),
    ).toMatchObject({ location: undefined });
  });

  it('drops whitespace around the location', () => {
    expect(
      readSettings({ FLAREWATCH_PROXY_LOCATION: ' Home lab ', FLAREWATCH_PROXY_TOKEN: TOKEN }),
    ).toMatchObject({ location: 'Home lab' });
  });

  it('drops whitespace around the token', () => {
    expect(readSettings({ FLAREWATCH_PROXY_TOKEN: ` ${TOKEN}\n` })).toMatchObject({
      authToken: TOKEN,
    });
  });

  it.each([undefined, '', '   '])('refuses the token %j', (token) => {
    expect(readSettings({ FLAREWATCH_PROXY_TOKEN: token })).toEqual({
      error: 'FLAREWATCH_PROXY_TOKEN is required',
    });
  });

  it('reads the previous token', () => {
    expect(
      readSettings({
        FLAREWATCH_PROXY_TOKEN: TOKEN,
        FLAREWATCH_PROXY_TOKEN_PREVIOUS: ' the-token-before-this-one\n',
      }),
    ).toMatchObject({ previousAuthToken: 'the-token-before-this-one' });
  });

  it('refuses a previous token shorter than 16 characters', () => {
    expect(
      readSettings({ FLAREWATCH_PROXY_TOKEN: TOKEN, FLAREWATCH_PROXY_TOKEN_PREVIOUS: 'short' }),
    ).toEqual({ error: 'FLAREWATCH_PROXY_TOKEN_PREVIOUS must be at least 16 characters' });
  });

  it('has no previous token when the variable is empty', () => {
    expect(
      readSettings({ FLAREWATCH_PROXY_TOKEN: TOKEN, FLAREWATCH_PROXY_TOKEN_PREVIOUS: '' }),
    ).toMatchObject({ previousAuthToken: undefined });
  });

  it('refuses a token shorter than 16 characters', () => {
    expect(readSettings({ FLAREWATCH_PROXY_TOKEN: 'fifteen-chars-x' })).toEqual({
      error: 'FLAREWATCH_PROXY_TOKEN must be at least 16 characters',
    });
    expect(readSettings({ FLAREWATCH_PROXY_TOKEN: 'sixteen-chars-xy' })).toMatchObject({
      authToken: 'sixteen-chars-xy',
    });
  });
});
