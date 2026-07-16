import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configSummary, DEV_SESSION_SECRET, loadConfig, repoRoot } from '../src/config.js';

describe('loadConfig', () => {
  it('applies plan defaults on an empty environment', () => {
    const config = loadConfig({});
    expect(config.authMode).toBe('clerk');
    expect(config.webPort).toBe(3000);
    expect(config.serverPort).toBe(8787);
    expect(config.relayPort).toBe(8788);
    expect(config.dataDir).toBe(path.join(repoRoot, 'data'));
    expect(config.databaseUrl).toBe(`file:${path.join(repoRoot, 'data', 'eduagent.db')}`);
    expect(config.codexBin).toBe('codex');
    expect(config.codexModel).toBe('gpt-5.6-sol');
    expect(config.sessionSecret).toBe(DEV_SESSION_SECRET);
    expect(config.accessCode).toBeUndefined();
    expect(config.corsOrigins).toContain('http://localhost:3000');
  });

  it('coerces numeric ports from strings', () => {
    const config = loadConfig({ SERVER_PORT: '9999', WEB_PORT: '3210' });
    expect(config.serverPort).toBe(9999);
    expect(config.corsOrigins).toContain('http://localhost:3210');
  });

  it('rejects an invalid AUTH_MODE', () => {
    expect(() => loadConfig({ AUTH_MODE: 'oauth' })).toThrow(/AUTH_MODE/);
  });

  it('rejects a too-short SESSION_SECRET', () => {
    expect(() => loadConfig({ SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  it('treats empty-string env values as unset (e.g. `ACCESS_CODE=` lines)', () => {
    const config = loadConfig({ ACCESS_CODE: '', AUTH_MODE: '' });
    expect(config.accessCode).toBeUndefined();
    expect(config.authMode).toBe('clerk');
  });

  it('lets DATABASE_URL override the DATA_DIR-derived default', () => {
    const config = loadConfig({ DATABASE_URL: 'file:/tmp/other.db' });
    expect(config.databaseUrl).toBe('file:/tmp/other.db');
  });

  it('resolves a relative DATA_DIR against the repo root', () => {
    const config = loadConfig({ DATA_DIR: './elsewhere' });
    expect(config.dataDir).toBe(path.join(repoRoot, 'elsewhere'));
  });
});

describe('configSummary', () => {
  it('exposes secrets only as presence booleans, never values', () => {
    const secrets = {
      CLERK_SECRET_KEY: 'sk_test_supersecretvalue',
      SESSION_SECRET: 'a-very-secret-session-secret',
      ACCESS_CODE: 'letmein-topsecret',
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_publishable',
    };
    const summary = configSummary(loadConfig(secrets));
    const dump = JSON.stringify(summary);
    for (const value of Object.values(secrets)) {
      expect(dump).not.toContain(value);
    }
    expect(summary.clerkSecretKeySet).toBe(true);
    expect(summary.clerkPublishableKeySet).toBe(true);
    expect(summary.accessCodeSet).toBe(true);
    expect(summary.sessionSecretIsDevDefault).toBe(false);
  });

  it('flags the dev-default session secret', () => {
    expect(configSummary(loadConfig({})).sessionSecretIsDevDefault).toBe(true);
    expect(configSummary(loadConfig({})).clerkSecretKeySet).toBe(false);
  });
});
