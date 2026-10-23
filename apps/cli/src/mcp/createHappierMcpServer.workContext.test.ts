import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeferredApiSessionClient, type DeferredApiSessionTarget } from '@/agent/runtime/startup/DeferredApiSessionClient';
import type { Metadata } from '@/api/types';
import { updateSessionMetadataWithAckResult } from '@/api/session/stateUpdates';
import { createHappierMcpServer } from './createHappierMcpServer';

function readResult(result: Awaited<ReturnType<Client['callTool']>>): any {
  const text = (result.content as Array<{ type: string; text?: string }>).find((entry) => entry.type === 'text')?.text;
  return JSON.parse(text ?? '{}');
}

describe('session work context MCP', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('reports a predecessor relay tag rejection and the context that already persisted', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: {} });
    let metadata = { path: '/repo', host: 'host' } as Metadata;
    const credentials = { token: 'test', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
    const deferred = new DeferredApiSessionClient({ placeholderSessionId: 'starting', limits: { maxEntries: 10, maxBytes: 10_000 } });
    await deferred.attach({
      sessionId: 'self', rpcHandlerManager: { invokeLocal: async () => ({}) } as any, sendClaudeSessionMessage: () => {}, updateMetadata: () => {},
      getMetadataSnapshot: () => metadata, getMetadataVersionSnapshot: () => 2, refreshMetadataSnapshot: async () => {},
      updateMetadataWithResult: async <TResult>(handler: (metadata: Metadata) => Readonly<{ metadata: Metadata; result: TResult }>) => { const update = handler(metadata); metadata = update.metadata; return update.result; },
    } as unknown as DeferredApiSessionTarget);
    const { mcp } = createHappierMcpServer(deferred, { credentials });
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = readResult(await client.callTool({ name: 'session_work_context_update', arguments: { patch: { branch: 'confirmed' }, tags: ['backend'] } }));
      expect(result).toMatchObject({ errorCode: 'session_tags_server_upgrade_required',
        details: { contextUpdated: true, context: { v: 1, branch: 'confirmed' }, skippedManualFields: [] } });
      expect(result.error).toContain('updated Happier relay');
      expect(metadata.sessionWorkContextV1?.branch).toBe('confirmed');
      vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { snapshot: {
        schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], orderEntries: [], labels: [], tagAssignments: [],
        tags: [{ tagId: 'known', tagKey: 'known', display: { t: 'plain', v: { label: 'Known' } }, sortKey: null, archivedAt: null, createdAt: 1, updatedAt: 1 }],
      } } });
      const put = vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: { sessionId: 'self', tagIds: ['manual', 'known'] } });
      const recovered = readResult(await client.callTool({ name: 'session_work_context_update', arguments: { tags: ['Known'] } }));
      expect(recovered).toMatchObject({ ok: true, tagIds: ['manual', 'known'], context: { branch: 'confirmed' }, skippedManualFields: [] });
      expect(put).toHaveBeenCalledWith(expect.stringContaining('/tag-assignments/self'), { tagIds: ['known'], mode: 'add', expectedMetadataVersion: 2 }, expect.anything());
      expect(metadata.sessionWorkContextV1).not.toHaveProperty('tags');
    } finally { await client.close(); await mcp.close(); }
  });
  it('uses the bound live session without credentials and reports locks from the winning CAS retry', async () => {
    let metadata = { path: '/repo', host: 'host', sessionWorkContextV1: { v: 1, branch: 'old' } } as Metadata;
    let version = 1;
    const emitWithAck = vi.fn(async (_event: string, payload: { metadata: string }) => {
      if (version === 1) return { result: 'version-mismatch', version: 2, metadata: JSON.stringify({ ...metadata,
        sessionWorkContextV1: { v: 1, branch: 'user branch', manualOverrides: { branch: true } } }) };
      return { result: 'success', version: 3, metadata: payload.metadata };
    });
    const deferred = new DeferredApiSessionClient({ placeholderSessionId: 'PID-starting', limits: { maxEntries: 10, maxBytes: 10_000 } });
    const target = {
      sessionId: 'self', rpcHandlerManager: { invokeLocal: async () => ({}) } as any,
      sendClaudeSessionMessage: () => {}, updateMetadata: () => {}, getMetadataSnapshot: () => metadata,
      updateMetadataWithResult: async <TResult>(handler: (metadata: Metadata) => Readonly<{ metadata: Metadata; result: TResult }>) => await updateSessionMetadataWithAckResult({
        socket: { emitWithAck }, sessionId: 'self', sessionEncryptionMode: 'plain', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy',
        getMetadata: () => metadata, setMetadata: (next) => { metadata = next!; },
        getMetadataVersion: () => version, setMetadataVersion: (next) => { version = next; },
        syncSessionSnapshotFromServer: async () => {}, handler,
      }),
    } as unknown as DeferredApiSessionTarget;
    const { mcp, toolNames } = createHappierMcpServer(deferred);
    expect(toolNames).toContain('session_work_context_get');
    expect(toolNames).toContain('session_work_context_update');
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const beforeAttach = readResult(await client.callTool({ name: 'session_work_context_update', arguments: { patch: { branch: 'must not queue' } } }));
      expect(beforeAttach).toMatchObject({ errorCode: 'session_metadata_unavailable' });
      const readBeforeAttach = readResult(await client.callTool({ name: 'session_work_context_get', arguments: {} }));
      expect(readBeforeAttach).toMatchObject({ errorCode: 'session_metadata_unavailable' });
      expect(deferred.getBufferStats().entryCount).toBe(0);
      await deferred.attach(target);
      const result = readResult(await client.callTool({ name: 'session_work_context_update', arguments: { patch: { branch: 'agent branch', tasks: [' TASK-1 '] } } }));
      expect(result).toMatchObject({ ok: true, context: { branch: 'user branch', tasks: ['TASK-1'] }, skippedManualFields: ['branch'] });
      expect(metadata.sessionWorkContextV1?.branch).toBe('user branch');
      const read = readResult(await client.callTool({ name: 'session_work_context_get', arguments: {} }));
      expect(read).toMatchObject({ ok: true, context: { tasks: ['TASK-1'], branch: 'user branch' } });
      const other = readResult(await client.callTool({ name: 'session_work_context_update', arguments: { sessionId: 'other', patch: { branch: 'leak' } } }));
      expect(other).toMatchObject({ errorCode: 'permission_denied' });
      expect(emitWithAck).toHaveBeenCalledTimes(2);
      const noCredentials = readResult(await client.callTool({ name: 'session_work_context_update', arguments: { patch: { description: 'must not commit' }, tags: ['backend'] } }));
      expect(noCredentials).toMatchObject({ errorCode: 'not_authenticated' });
      expect(metadata.sessionWorkContextV1?.description).toBeUndefined();
      expect(emitWithAck).toHaveBeenCalledTimes(2);
    } finally { await client.close(); await mcp.close(); }
  });
});
