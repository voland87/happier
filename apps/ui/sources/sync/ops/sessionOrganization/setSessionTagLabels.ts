import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    normalizeSessionTagLabels,
    readSessionOrganizationServerScopedId,
    readSessionOrganizationTagLabel,
} from '@/sync/domains/session/organization';
import { getStorage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { parseToken } from '@/utils/auth/parseToken';
import { applySessionWorkContextPatchV1, type SessionOrganizationTag } from '@happier-dev/protocol';
import { sync } from '@/sync/sync';

import { setSessionTagAssignments } from './setSessionTagAssignments';
import { fetchAndApplySessionOrganizationSnapshot } from './fetchSessionOrganizationSnapshot';
import { createSessionOrganizationOpaqueId } from './sessionOrganizationIdAllocation';
import { upsertSessionTag } from './upsertSessionTag';

function readCurrentServerTags(serverId: string): SessionOrganizationTag[] {
    const state = getStorage().getState();
    const tags: SessionOrganizationTag[] = [];
    for (const [key, tag] of Object.entries(state.sessionOrganizationTagsByTagKey)) {
        if (readSessionOrganizationServerScopedId(key, serverId) !== tag.tagId) continue;
        if (tag.archivedAt != null) continue;
        tags.push(tag);
    }
    return tags.sort((a, b) => {
        const leftSort = a.sortKey ?? '';
        const rightSort = b.sortKey ?? '';
        if (leftSort !== rightSort) return leftSort.localeCompare(rightSort);
        return a.tagId.localeCompare(b.tagId);
    });
}

function findTagByLabel(tags: readonly SessionOrganizationTag[], label: string): SessionOrganizationTag | null {
    return tags.find((tag) => readSessionOrganizationTagLabel(tag) === label) ?? null;
}

function resolveExistingTagsByLabel(params: Readonly<{
    labels: readonly string[];
    tags: readonly SessionOrganizationTag[];
}>): {
    resolvedTags: SessionOrganizationTag[];
    missingLabels: string[];
} {
    const resolvedTags: SessionOrganizationTag[] = [];
    const missingLabels: string[] = [];
    for (const label of params.labels) {
        const existing = findTagByLabel([...params.tags, ...resolvedTags], label);
        if (existing) {
            resolvedTags.push(existing);
        } else {
            missingLabels.push(label);
        }
    }
    return { resolvedTags, missingLabels };
}

function isSessionTagAssignmentOwner(params: Readonly<{
    sessionId: string;
    serverId: string;
    credentials: AuthCredentials;
}>): boolean {
    const state = getStorage().getState();
    const activeServerId = getActiveServerSnapshot().serverId;
    const targetsActiveServer = areServerProfileIdentifiersEquivalent(activeServerId, params.serverId);
    const hydrated = state.sessions[params.sessionId];
    const hydratedMatches = hydrated && (hydrated.serverId
        ? areServerProfileIdentifiersEquivalent(hydrated.serverId, params.serverId)
        : targetsActiveServer);
    const cached = Object.entries(state.sessionListViewDataByServerId).find(([serverId]) =>
        areServerProfileIdentifiersEquivalent(serverId, params.serverId))?.[1]
        ?.find((item) => item.type === 'session' && item.session.id === params.sessionId);
    const session = hydratedMatches ? hydrated
        : cached?.type === 'session' ? cached.session
            : targetsActiveServer ? state.sessionListRenderables[params.sessionId] : undefined;
    // Older/uncached callers retain the metadata CAS and its errors. A known
    // recipient's account-local assignments must never lock the owner's agent.
    if (!session) return true;
    const ownerId = typeof session.owner === 'string' ? session.owner : null;
    return ownerId ? ownerId === parseToken(params.credentials.token) : session.accessLevel == null;
}

export async function setSessionTagLabels(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    sessionId: string;
    tags: readonly string[];
}>): Promise<void> {
    // Tags belong to the account, while the autofill marker belongs to the
    // session owner. Shared recipients keep personal tagging at every access level.
    if (isSessionTagAssignmentOwner(params)) {
        await sync.patchSessionMetadataWithRetry(params.sessionId, (metadata) => ({
            ...metadata,
            sessionWorkContextV1: applySessionWorkContextPatchV1({
                current: metadata.sessionWorkContextV1,
                patch: {},
                source: 'user',
                lockManualFields: ['tags'],
            }).context,
        }), { serverId: params.serverId });
    }
    const labels = normalizeSessionTagLabels(params.tags);
    if (labels.length === 0) {
        await setSessionTagAssignments({
            credentials: params.credentials,
            serverId: params.serverId,
            serverUrl: params.serverUrl,
            sessionId: params.sessionId,
            tagIds: [],
        });
        return;
    }

    let currentTags = readCurrentServerTags(params.serverId);
    const firstResolution = resolveExistingTagsByLabel({ labels, tags: currentTags });
    if (firstResolution.missingLabels.length > 0) {
        await fetchAndApplySessionOrganizationSnapshot({
            credentials: params.credentials,
            serverId: params.serverId,
            serverUrl: params.serverUrl,
            request: {
                includeFolders: false,
                includeTags: true,
                includeLabels: false,
            },
        });
        currentTags = readCurrentServerTags(params.serverId);
    }

    const usedIds = new Set(currentTags.map((tag) => tag.tagId));
    const resolvedTags: SessionOrganizationTag[] = [];

    for (const label of labels) {
        const existing = findTagByLabel([...currentTags, ...resolvedTags], label);
        if (existing) {
            resolvedTags.push(existing);
            continue;
        }
        const tagId = createSessionOrganizationOpaqueId({ prefix: 'tag', usedIds });
        usedIds.add(tagId);
        const created = await upsertSessionTag({
            credentials: params.credentials,
            serverId: params.serverId,
            serverUrl: params.serverUrl,
            request: {
                tagId,
                tagKey: tagId,
                sortKey: null,
                display: { t: 'plain', v: { label } },
            },
        });
        resolvedTags.push(created);
    }

    await setSessionTagAssignments({
        credentials: params.credentials,
        serverId: params.serverId,
        serverUrl: params.serverUrl,
        sessionId: params.sessionId,
        tagIds: resolvedTags.map((tag) => tag.tagId),
    });
}
