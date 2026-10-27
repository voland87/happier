import { randomUUID } from 'node:crypto';
import axios from 'axios';
import {
    AccountEncryptionModeResponseSchema,
    CreateOrUpdateSessionOrganizationTagResponseSchema,
    SetSessionTagAssignmentsConflictResponseSchema,
    SESSION_ORGANIZATION_MAX_ASSIGNMENTS_PER_MUTATION,
    SetSessionTagAssignmentsResponseSchema,
    SessionOrganizationSnapshotResponseSchema,
    openAccountScopedBlobCiphertext,
    readSessionWorkContextV1,
    sealAccountScopedBlobCiphertext,
    type SessionOrganizationContentEnvelope,
    type SessionOrganizationTag,
} from '@happier-dev/protocol';
import { createHttpStatusError, createInvalidResponseShapeError } from '@/api/client/httpStatusError';
import { throwIfCliClientUpgradeRequired } from '@/api/clientCompatibility/cliClientCompatibility';
import { getRandomBytes } from '@/api/encryption';
import { configuration } from '@/configuration';
import { requireEncryptionCredentials, type Credentials } from '@/persistence';
import { fetchSessionByIdCompat, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';
import { createBackoff } from '@/utils/time';

export interface SessionWorkContextTagsClient {
    getMetadataSnapshot(): unknown;
    getMetadataVersionSnapshot(): number;
    refreshMetadataSnapshot(): Promise<void>;
}

class TagMetadataVersionConflict extends Error {}

function upgradeRequired(): Error & { code: string; retryable: false } {
    return Object.assign(new Error('Tag autofill requires an updated Happier relay with additive tag assignments.'), {
        code: 'session_tags_server_upgrade_required', retryable: false as const,
    });
}

function requireSuccess(response: { status: number; data: unknown }): void {
    throwIfCliClientUpgradeRequired(response.status, response.data);
    if (response.status !== 200) throw createHttpStatusError(response.status, `Session tag operation failed (${response.status})`);
}

function readTagLabel(tag: SessionOrganizationTag, credentials: Credentials): string {
    const display = tag.display?.t === 'plain' ? tag.display.v
        : tag.display?.t === 'encrypted' && credentials.encryption
            ? openAccountScopedBlobCiphertext({ kind: 'session_organization_display', material: credentials.encryption, ciphertext: tag.display.c })?.value
            : null;
    if (display && typeof display === 'object' && 'label' in display && typeof display.label === 'string' && display.label.trim()) {
        return display.label.trim();
    }
    // Match the native picker fallback, without treating an opaque encrypted
    // label as known plaintext or rewriting an existing global definition.
    return tag.tagKey || tag.tagId;
}

/** Add agent suggestions to native tags, preserving every existing assignment. */
export async function updateSessionWorkContextTags(params: Readonly<{
    sessionId: string;
    tags: readonly string[];
    credentials: Credentials;
    session?: SessionWorkContextTagsClient;
}>): Promise<{ tagIds: string[]; skippedManualFields: string[] }> {
    const labels = [...new Set(params.tags.map((label) => label.trim()).filter(Boolean))];
    if (labels.length === 0) return { tagIds: [], skippedManualFields: [] };
    // Reuse the mutation owner's collection limit before any definition writes.
    if (labels.length > SESSION_ORGANIZATION_MAX_ASSIGNMENTS_PER_MUTATION) throw new Error('Too many session tags in one update');
    let rawSession: RawSessionRecord | null = null;
    const session: SessionWorkContextTagsClient = params.session ?? {
        getMetadataSnapshot: () => rawSession ? tryDecryptSessionMetadata({ credentials: params.credentials, rawSession }) : null,
        getMetadataVersionSnapshot: () => rawSession?.metadataVersion ?? -1,
        refreshMetadataSnapshot: async () => {
            rawSession = await fetchSessionByIdCompat({ token: params.credentials.token, sessionId: params.sessionId });
            if (!rawSession) throw createHttpStatusError(404, 'Session not found', 'session_not_found');
        },
    };
    const baseUrl = resolveServerHttpBaseUrl();
    const options = {
        headers: { Authorization: `Bearer ${params.credentials.token}`, 'Content-Type': 'application/json' },
        timeout: configuration.sessionControlHttpTimeoutMs,
        validateStatus: () => true,
    };
    const retryVersionConflict = createBackoff({ shouldRetry: (error) => error instanceof TagMetadataVersionConflict });
    return await retryVersionConflict(async () => {
        await session.refreshMetadataSnapshot();
        const metadata = session.getMetadataSnapshot();
        if (!metadata || typeof metadata !== 'object') throw new Error('Session metadata is unavailable for tag autofill');
        const context = readSessionWorkContextV1((metadata as Record<string, unknown>).sessionWorkContextV1);
        if (context?.manualOverrides?.tags === true) return { tagIds: [], skippedManualFields: ['tags'] };
        const expectedMetadataVersion = session.getMetadataVersionSnapshot();
        if (!Number.isInteger(expectedMetadataVersion) || expectedMetadataVersion < 0) throw new Error('Session metadata version is unavailable for tag autofill');

        const response = await axios.get(`${baseUrl}/v2/session-organization`, {
            ...options, params: { includeFolders: false, includeTags: true, includeLabels: false },
        });
        if (response.status === 404) throw upgradeRequired();
        requireSuccess(response);
        const parsed = SessionOrganizationSnapshotResponseSchema.safeParse(response.data);
        if (!parsed.success) throw createInvalidResponseShapeError('Invalid session organization snapshot');
        const tags = parsed.data.snapshot.tags.filter((tag) => tag.archivedAt === null);
        const byLabel = new Map(tags.map((tag) => [readTagLabel(tag, params.credentials), tag]));
        const missing = labels.filter((label) => !byLabel.has(label));
        let plain = false;
        if (missing.length > 0) {
            const encryptionResponse = await axios.get(`${baseUrl}/v1/account/encryption`, options);
            if (encryptionResponse.status !== 404) {
                requireSuccess(encryptionResponse);
                const encryption = AccountEncryptionModeResponseSchema.safeParse(encryptionResponse.data);
                if (!encryption.success) throw createInvalidResponseShapeError('Invalid account encryption mode');
                plain = encryption.data.mode === 'plain';
            }
        }
        for (const label of missing) {
            const id = `tag_${randomUUID().replace(/-/g, '')}`;
            let display: SessionOrganizationContentEnvelope;
            if (plain) {
                display = { t: 'plain', v: { label } };
            } else {
                requireEncryptionCredentials(params.credentials);
                display = {
                    t: 'encrypted',
                    c: sealAccountScopedBlobCiphertext({ kind: 'session_organization_display', material: params.credentials.encryption, payload: { label }, randomBytes: getRandomBytes }),
                };
            }
            const createdResponse = await axios.post(`${baseUrl}/v2/session-organization/tags`, {
                tagId: id, tagKey: id, sortKey: null, display,
            }, options);
            requireSuccess(createdResponse);
            const created = CreateOrUpdateSessionOrganizationTagResponseSchema.safeParse(createdResponse.data);
            if (!created.success) throw createInvalidResponseShapeError('Invalid session tag creation response');
            byLabel.set(label, created.data.tag);
        }
        const tagIds = labels.map((label) => byLabel.get(label)!.tagId);
        const assignment = await axios.put(`${baseUrl}/v2/session-organization/tag-assignments/${encodeURIComponent(params.sessionId)}`, {
            tagIds, mode: 'add', expectedMetadataVersion,
        }, options);
        if (assignment.status === 409 && SetSessionTagAssignmentsConflictResponseSchema.safeParse(assignment.data).success) {
            throw new TagMetadataVersionConflict('Session metadata changed during tag autofill');
        }
        // The released predecessor has a strict {tagIds} body; never retry by
        // dropping the additive mode and accidentally replacing manual tags.
        if (assignment.status === 400) {
            throw Object.assign(new Error('Relay rejected additive tag assignments; update it if additive writes are unsupported.'), {
                code: 'relay_rejected_additive_tag_assignments', retryable: false,
            });
        }
        requireSuccess(assignment);
        const result = SetSessionTagAssignmentsResponseSchema.safeParse(assignment.data);
        if (!result.success) throw createInvalidResponseShapeError('Invalid session tag assignment response');
        return { tagIds: result.data.tagIds, skippedManualFields: [] };
    });
}
