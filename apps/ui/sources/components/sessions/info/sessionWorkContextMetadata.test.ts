import { beforeEach, describe, expect, it, vi } from 'vitest';

const patchSessionMetadataWithRetry = vi.hoisted(() => vi.fn());

vi.mock('@/sync/sync', () => ({
    sync: { patchSessionMetadataWithRetry },
}));

describe('session work-context metadata writes', () => {
    beforeEach(() => {
        patchSessionMetadataWithRetry.mockReset();
        patchSessionMetadataWithRetry.mockResolvedValue(undefined);
    });

    it('applies manual edits inside the retry updater and preserves unrelated/latest metadata', async () => {
        const { patchSessionWorkContextMetadata } = await import('./sessionWorkContextMetadata');
        await patchSessionWorkContextMetadata({
            sessionId: 'session-1',
            serverId: 'server-b',
            patch: { tasks: ['TASK-2'], description: null },
        });

        expect(patchSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
        const [sessionId, update, options] = patchSessionMetadataWithRetry.mock.calls[0] as [
            string,
            (metadata: Record<string, unknown>) => Record<string, unknown>,
            unknown,
        ];
        expect(sessionId).toBe('session-1');
        expect(options).toEqual({ serverId: 'server-b' });
        const result = update({
            name: 'Session name',
            unrelated: { keep: true },
            sessionWorkContextV1: {
                v: 1,
                tasks: ['TASK-1', 'TASK-latest-agent-update'],
                branch: 'latest-agent-branch',
                description: 'agent description',
                customFields: { team: 'ui' },
                manualOverrides: { branch: true },
            },
        });
        expect(result).toEqual({
            name: 'Session name',
            unrelated: { keep: true },
            sessionWorkContextV1: {
                v: 1,
                tasks: ['TASK-2'],
                branch: 'latest-agent-branch',
                customFields: { team: 'ui' },
                manualOverrides: { branch: true, tasks: true, description: true },
            },
        });
    });

    it('removes only the requested manual lock while retaining its current value', async () => {
        const { patchSessionWorkContextMetadata } = await import('./sessionWorkContextMetadata');
        await patchSessionWorkContextMetadata({
            sessionId: 'session-2',
            serverId: null,
            patch: {},
            resetManualFields: ['tags'],
        });

        const [, update, options] = patchSessionMetadataWithRetry.mock.calls[0] as [
            string,
            (metadata: Record<string, unknown>) => Record<string, unknown>,
            unknown,
        ];
        expect(options).toBeUndefined();
        expect(update({
            path: '/repo',
            sessionWorkContextV1: {
                v: 1,
                branch: 'main',
                manualOverrides: { tags: true, branch: true },
            },
        })).toEqual({
            path: '/repo',
            sessionWorkContextV1: {
                v: 1,
                branch: 'main',
                manualOverrides: { branch: true },
            },
        });
    });
});
