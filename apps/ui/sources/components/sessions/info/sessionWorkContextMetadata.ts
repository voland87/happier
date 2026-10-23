import {
    applySessionWorkContextPatchV1,
    type SessionWorkContextPatchV1,
} from '@happier-dev/protocol';

import { sync } from '@/sync/sync';

export async function patchSessionWorkContextMetadata(params: Readonly<{
    sessionId: string;
    serverId: string | null;
    patch: SessionWorkContextPatchV1;
    resetManualFields?: readonly string[];
}>): Promise<void> {
    await sync.patchSessionMetadataWithRetry(params.sessionId, (metadata) => {
        const { context } = applySessionWorkContextPatchV1({
            current: metadata.sessionWorkContextV1,
            patch: params.patch,
            source: 'user',
            resetManualFields: params.resetManualFields,
        });
        return {
            ...metadata,
            sessionWorkContextV1: context,
        };
    }, params.serverId ? { serverId: params.serverId } : undefined);
}
