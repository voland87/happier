import axios from 'axios';
import { createActionExecutor } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { getSessionWorkContext, updateSessionWorkContext } from './sessionWorkContext';

const { fetchSessionById, patchSessionMetadata, waitForSocketConnect } = vi.hoisted(() => ({
  fetchSessionById: vi.fn(), patchSessionMetadata: vi.fn(), waitForSocketConnect: vi.fn(),
}));
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(), fetchSessionById, fetchSessionByIdCompat: fetchSessionById, patchSessionMetadata,
}));
vi.mock('@/session/transport/socket/waitForSocketConnect', () => ({ waitForSocketConnect }));
vi.mock('@/api/session/sockets', () => ({ createSessionScopedSocket: () => ({ connect() {}, close() {}, disconnect() {} }) }));

const credentials = { token: 'test', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
const sessionId = 'c123456789012345678901234';

describe('session work context CLI service', () => {
  beforeEach(() => { vi.clearAllMocks(); waitForSocketConnect.mockRejectedValue(new Error('offline')); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('preserves typed tag failures and committed context through the default CLI action', async () => {
    const metadata = { path: '/repo', sessionWorkContextV1: { v: 1, branch: 'confirmed' } };
    fetchSessionById.mockResolvedValue({ id: sessionId, metadata: JSON.stringify(metadata), metadataVersion: 1, encryptionMode: 'plain' });
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: {} });
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId, ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' } });
    const result = await createActionExecutor(deps).execute('session.work_context.update', { sessionId, patch: { branch: 'confirmed' }, tags: ['backend'] }, { surface: 'cli' });
    expect(result).toMatchObject({ ok: false, errorCode: 'session_tags_server_upgrade_required',
      details: { contextUpdated: true, context: { v: 1, branch: 'confirmed' }, skippedManualFields: [] } });
  });

  it('re-evaluates manual locks through the default CLI dependency on HTTP CAS conflict and preserves unrelated metadata', async () => {
    const initial = { path: '/repo', future: 42, sessionWorkContextV1: { v: 1, branch: 'old' } };
    fetchSessionById.mockResolvedValue({ id: sessionId, metadata: JSON.stringify(initial), metadataVersion: 1, encryptionMode: 'plain' });
    patchSessionMetadata.mockResolvedValueOnce({ success: false, current: { version: 2, value: JSON.stringify({ ...initial,
      sessionWorkContextV1: { v: 1, branch: 'user', manualOverrides: { branch: true } } }) } })
      .mockImplementationOnce(async (args) => ({ success: true, version: 3, metadata: args.ciphertext }));
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId,
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' } });
    const result = await deps.sessionWorkContextUpdate!({ sessionId, patch: { branch: 'agent', tasks: ['TASK-1'] } });
    expect(result).toMatchObject({ ok: true, context: { branch: 'user', tasks: ['TASK-1'] }, skippedManualFields: ['branch'] });
    const winning = JSON.parse(patchSessionMetadata.mock.calls[1][0].ciphertext);
    expect(winning).toMatchObject({ future: 42, sessionWorkContextV1: { branch: 'user', tasks: ['TASK-1'] } });
    expect(patchSessionMetadata.mock.calls[1][0].expectedVersion).toBe(2);
  });

  it('accepts an older session without context and preserves encrypted metadata reads', async () => {
    fetchSessionById.mockResolvedValue({ id: sessionId, metadata: JSON.stringify({ path: '/repo' }), metadataVersion: 1, encryptionMode: 'plain' });
    expect(await getSessionWorkContext({ credentials, idOrPrefix: sessionId })).toMatchObject({ ok: true, context: null });
    const { encrypt, encodeBase64 } = await import('@/api/encryption');
    fetchSessionById.mockResolvedValue({ id: sessionId, metadata: encodeBase64(encrypt(credentials.encryption.secret, 'legacy', {
      path: '/repo', sessionWorkContextV1: { v: 1, repository: 'confirmed/repo' },
    })), metadataVersion: 1, encryptionMode: 'e2ee' });
    expect(await getSessionWorkContext({ credentials, idOrPrefix: sessionId })).toMatchObject({ ok: true, context: { repository: 'confirmed/repo' } });
  });

  it('does not write when all patched fields are manually locked', async () => {
    fetchSessionById.mockResolvedValue({ id: sessionId, metadata: JSON.stringify({ path: '/repo', sessionWorkContextV1: {
      v: 1, branch: 'user', manualOverrides: { branch: true },
    } }), metadataVersion: 1, encryptionMode: 'plain' });
    expect(await updateSessionWorkContext({ credentials, idOrPrefix: sessionId, patch: { branch: 'agent' } })).toMatchObject({ ok: true, skippedManualFields: ['branch'] });
    expect(patchSessionMetadata).not.toHaveBeenCalled();
  });
});
