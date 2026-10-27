import { describe, expect, it } from 'vitest';

import { parseConnectArgs } from './parseConnectArgs';

describe('parseConnectArgs', () => {
  it('parses native import and its provider-declared source', () => {
    expect(parseConnectArgs(['agy', '--import', '--source', 'acp', '--profile', 'personal']).options).toMatchObject({ import: true, source: 'acp', profileId: 'personal' });
  });
  it('parses --device and --profile and a subcommand', () => {
    const res = parseConnectArgs(['codex', '--device', '--profile', 'work']);
    expect(res.subcommand).toBe('codex');
    expect(res.options.profileId).toBe('work');
    expect(res.options.device).toBe(true);
  });

  it('defaults profile to default', () => {
    const res = parseConnectArgs(['codex']);
    expect(res.options.profileId).toBe('default');
  });

  it('parses --oauth', () => {
    const res = parseConnectArgs(['claude', '--oauth']);
    expect(res.options.oauth).toBe(true);
  });

  it('parses --api-key', () => {
    const res = parseConnectArgs(['claude', '--api-key']);
    expect(res.options.apiKey).toBe(true);
  });

  it('parses --token', () => {
    const res = parseConnectArgs(['github', '--token']);
    expect(res.options.token).toBe(true);
  });
});
