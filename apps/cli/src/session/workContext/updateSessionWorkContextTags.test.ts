import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import { encodeBase64, encrypt } from '@/api/encryption';
import { updateSessionWorkContextTags } from './updateSessionWorkContextTags';

vi.mock('axios', () => ({ default: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }));
const credentials = { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) } } satisfies Credentials;
const tag = (id: string, display: unknown = { t: 'plain', v: { label: 'Known' } }) => ({ tagId: id, tagKey: id, display, sortKey: null, archivedAt: null, createdAt: 1, updatedAt: 1 });
function snapshot(tags = [tag('known')]) {
    return { status: 200, data: { snapshot: { schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], tags, tagAssignments: [], orderEntries: [], labels: [] } } };
}
function session() {
    let metadata: unknown = { sessionWorkContextV1: { v: 1 } };
    let version = 2;
    return { getMetadataSnapshot: () => metadata, getMetadataVersionSnapshot: () => version, refreshMetadataSnapshot: vi.fn(async () => {}), lock: () => { metadata = { sessionWorkContextV1: { v: 1, manualOverrides: { tags: true } } }; version++; } };
}

describe('agent canonical tag autofill', () => {
    it('uses additive version-fenced assignments and does not rename known encrypted labels', async () => {
        vi.resetAllMocks();
        const encrypted = { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'session_organization_display', material: credentials.encryption, payload: { label: 'Known' }, randomBytes: (n) => new Uint8Array(n).fill(2) }) };
        vi.mocked(axios.get).mockResolvedValue(snapshot([tag('known', encrypted)]));
        vi.mocked(axios.put).mockResolvedValue({ status: 200, data: { sessionId: 's1', tagIds: ['manual', 'known'] } });
        const client = session();
        await expect(updateSessionWorkContextTags({ sessionId: 's1', tags: ['Known', 'Known'], credentials, session: client })).resolves.toEqual({ tagIds: ['manual', 'known'], skippedManualFields: [] });
        expect(axios.put).toHaveBeenCalledWith(expect.stringContaining('/tag-assignments/s1'), { tagIds: ['known'], mode: 'add', expectedMetadataVersion: 2 }, expect.anything());
        expect(axios.post).not.toHaveBeenCalled();
    });

    it('reloads metadata and observes a manual lock after version conflict', async () => {
        vi.resetAllMocks();
        const client = session();
        vi.mocked(axios.get).mockResolvedValue(snapshot());
        vi.mocked(axios.put).mockImplementation(async () => { client.lock(); return { status: 409, data: { error: 'metadata-version-conflict', currentMetadataVersion: 3 } }; });
        await expect(updateSessionWorkContextTags({ sessionId: 's1', tags: ['Known'], credentials, session: client })).resolves.toEqual({ tagIds: [], skippedManualFields: ['tags'] });
        expect(axios.put).toHaveBeenCalledTimes(1);
        expect(client.refreshMetadataSnapshot).toHaveBeenCalledTimes(2);
    });

    it('fails clearly on predecessor strict request rejection without replacing tags', async () => {
        vi.resetAllMocks();
        vi.mocked(axios.get).mockResolvedValue(snapshot());
        vi.mocked(axios.put).mockResolvedValue({ status: 400, data: { error: 'invalid-session-tag-assignments' } });
        await expect(updateSessionWorkContextTags({ sessionId: 's1', tags: ['Known'], credentials, session: session() })).rejects.toMatchObject({ code: 'relay_rejected_additive_tag_assignments' });
        expect(axios.put).toHaveBeenCalledTimes(1);
        expect(vi.mocked(axios.put).mock.calls[0][1]).toMatchObject({ mode: 'add' });
    });

    it('creates new encrypted tag definitions using canonical account crypto', async () => {
        vi.resetAllMocks();
        vi.mocked(axios.get).mockImplementation(async (url) => String(url).endsWith('/v1/account/encryption') ? { status: 200, data: { mode: 'e2ee', updatedAt: 0 } } : snapshot([]));
        vi.mocked(axios.post).mockImplementation(async (_url, body: any) => ({ status: 200, data: { tag: tag(body.tagId, body.display) } }));
        vi.mocked(axios.put).mockResolvedValue({ status: 200, data: { sessionId: 's1', tagIds: ['created'] } });
        await updateSessionWorkContextTags({ sessionId: 's1', tags: ['New'], credentials, session: session() });
        const body = vi.mocked(axios.post).mock.calls[0][1] as any;
        expect(body.tagId).toBe(body.tagKey);
        expect(body.display.t).toBe('encrypted');
        expect(openAccountScopedBlobCiphertext({ kind: 'session_organization_display', material: credentials.encryption, ciphertext: body.display.c })?.value).toEqual({ label: 'New' });
    });

    it('re-reads and decrypts external session metadata after a version conflict', async () => {
        vi.resetAllMocks();
        let reads = 0;
        vi.mocked(axios.get).mockImplementation(async (url) => {
            if (!String(url).includes('/v2/sessions/')) return snapshot();
            reads++;
            const metadata = { sessionWorkContextV1: { v: 1, ...(reads > 1 ? { manualOverrides: { tags: true } } : {}) } };
            return { status: 200, data: { session: {
                id: 's1', seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
                metadata: encodeBase64(encrypt(new Uint8Array(32).fill(7), 'legacy', metadata)), metadataVersion: reads + 1,
                agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
            } } };
        });
        vi.mocked(axios.put).mockResolvedValue({ status: 409, data: { error: 'metadata-version-conflict', currentMetadataVersion: 3 } });
        await expect(updateSessionWorkContextTags({ sessionId: 's1', tags: ['Known'], credentials })).resolves.toEqual({ tagIds: [], skippedManualFields: ['tags'] });
        expect(reads).toBe(2);
        expect(axios.put).toHaveBeenCalledTimes(1);
    });

    it('creates explicit plaintext displays with token-only credentials while retaining existing tags', async () => {
        vi.resetAllMocks();
        const opaque = { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'session_organization_display', material: credentials.encryption, payload: { label: 'Private' }, randomBytes: (n) => new Uint8Array(n).fill(2) }) };
        vi.mocked(axios.get).mockImplementation(async (url) => String(url).endsWith('/v1/account/encryption') ? { status: 200, data: { mode: 'plain', updatedAt: 0 } } : snapshot([tag('known'), tag('opaque', opaque)]));
        vi.mocked(axios.post).mockImplementation(async (_url, body: any) => ({ status: 200, data: { tag: tag(body.tagId, body.display) } }));
        vi.mocked(axios.put).mockResolvedValue({ status: 200, data: { sessionId: 's1', tagIds: ['created'] } });
        await updateSessionWorkContextTags({ sessionId: 's1', tags: ['Known', 'New'], credentials: { token: 'plain-token', encryption: null }, session: session() });
        expect(axios.post).toHaveBeenCalledTimes(1);
        expect(vi.mocked(axios.post).mock.calls[0][1]).toMatchObject({ display: { t: 'plain', v: { label: 'New' } } });
        expect(vi.mocked(axios.put).mock.calls[0][1]).toMatchObject({ tagIds: ['known', expect.any(String)], mode: 'add' });
    });

    it.each(['e2ee', 'unknown'] as const)('requires encryption keys before creating tags when account mode is %s', async (mode) => {
        vi.resetAllMocks();
        vi.mocked(axios.get).mockImplementation(async (url) => String(url).endsWith('/v1/account/encryption')
            ? mode === 'unknown' ? { status: 404, data: {} } : { status: 200, data: { mode, updatedAt: 0 } }
            : snapshot([]));

        await expect(updateSessionWorkContextTags({ sessionId: 's1', tags: ['New'], credentials: { token: 'plain-token', encryption: null }, session: session() }))
            .rejects.toMatchObject({ code: 'ACCOUNT_ENCRYPTION_KEY_REQUIRED' });
        expect(axios.post).not.toHaveBeenCalled();
        expect(axios.put).not.toHaveBeenCalled();
    });

    it('does no network writes when manual tags were already locked', async () => {
        vi.resetAllMocks();
        const client = session(); client.lock();
        await expect(updateSessionWorkContextTags({ sessionId: 's1', tags: ['Known'], credentials, session: client })).resolves.toEqual({ tagIds: [], skippedManualFields: ['tags'] });
        expect(axios.get).not.toHaveBeenCalled(); expect(axios.put).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
    });
});
