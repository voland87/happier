import {
  applySessionWorkContextPatchV1,
  readSessionWorkContextV1,
  type SessionWorkContextPatchV1,
  type SessionWorkContextV1,
} from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import { updateSessionWorkContextTags } from '@/session/workContext/updateSessionWorkContextTags';
import { decryptStoredSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveSessionTransportContext } from './resolveSessionTransportContext';
import { updateSessionMetadataForTarget } from './updateSessionMetadataForTarget';

export function createSessionWorkContextTagsFailure(params: Readonly<{
  error: unknown;
  sessionId: string;
  context: SessionWorkContextV1 | null;
  skippedManualFields: readonly string[];
}>) {
  const code = params.error && typeof params.error === 'object' && 'code' in params.error ? params.error.code : null;
  const errorCode = typeof code === 'string' && code.trim() ? code : 'session_tags_update_failed';
  const error = params.error instanceof Error ? params.error.message : errorCode;
  return { ok: false as const, errorCode, error, details: {
    sessionId: params.sessionId, contextUpdated: true, context: params.context, skippedManualFields: [...params.skippedManualFields],
  } };
}

export async function getSessionWorkContext(params: Readonly<{ credentials: Credentials; idOrPrefix: string }>) {
  const target = await resolveSessionTransportContext(params);
  if (!target.ok) return { ok: false as const, errorCode: target.code, error: target.code };
  const metadata = decryptStoredSessionPayload({
    mode: target.mode,
    ctx: target.ctx,
    value: target.rawSession.metadata,
  });
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { ok: false as const, errorCode: 'unsupported', error: 'unsupported' };
  }
  return { ok: true as const, sessionId: target.sessionId, context: readSessionWorkContextV1((metadata as Record<string, unknown>).sessionWorkContextV1) };
}

export async function updateSessionWorkContext(params: Readonly<{ credentials: Credentials; idOrPrefix: string; patch: SessionWorkContextPatchV1; tags?: string[] }>) {
  let applied: ReturnType<typeof applySessionWorkContextPatchV1> | undefined;
  const result = await updateSessionMetadataForTarget({
    credentials: params.credentials, idOrPrefix: params.idOrPrefix,
    // Re-evaluate user locks against the winning metadata on every CAS retry.
    updater: (metadata) => {
      applied = applySessionWorkContextPatchV1({ current: metadata.sessionWorkContextV1, patch: params.patch, source: 'agent' });
      return { ...metadata, sessionWorkContextV1: applied.context };
    },
  });
  if (!result.ok) return { ok: false as const, errorCode: result.code, error: result.code };
  const context = readSessionWorkContextV1(result.metadata.sessionWorkContextV1);
  let tags: Awaited<ReturnType<typeof updateSessionWorkContextTags>> | null = null;
  if (params.tags !== undefined) {
    try {
      tags = await updateSessionWorkContextTags({ sessionId: result.sessionId, credentials: params.credentials, tags: params.tags });
    } catch (error) {
      return createSessionWorkContextTagsFailure({ error, sessionId: result.sessionId, context, skippedManualFields: applied?.skippedManualFields ?? [] });
    }
  }
  return { ok: true as const, sessionId: result.sessionId,
    context,
    ...(tags ? { tagIds: tags.tagIds } : {}),
    skippedManualFields: [...(applied?.skippedManualFields ?? []), ...(tags?.skippedManualFields ?? [])] };
}
