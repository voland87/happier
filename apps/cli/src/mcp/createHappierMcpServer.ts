import { createSessionWorkContextTagsFailure } from '@/session/services/sessionWorkContext';
import { updateSessionWorkContextTags } from '@/session/workContext/updateSessionWorkContextTags';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import type { Metadata } from '@/api/types';
import { logger } from '@/ui/logger';

import { registerHappierMcpResources } from '@/mcp/resources/registerHappierMcpResources';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createChangeTitleToolHandler } from '@/agent/tools/happierTools/createChangeTitleToolHandler';
import { createStartExecutionRunToolHandler } from '@/agent/tools/happierTools/createStartExecutionRunToolHandler';
import { normalizeExecutionRunRpcPayload } from '@/session/services/executionRuns';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import type { Credentials } from '@/persistence';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createDaemonMemoryActionDeps } from '@/session/actions/createDaemonMemoryActionDeps';
import { resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import {
  applySessionWorkContextPatchV1,
  readSessionWorkContextV1,
  PromptRegistryInstallRequestV1Schema,
  PromptRegistryInstallResponseV1Schema,
  type ActionId,
  type AccountSettings,
  type BackendTargetRefV1,
  getActionSpec,
  isActionSpecSurfacedOn,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  createMcpActionApprovalRequirement,
  createMcpActionEnablement,
  createMcpActionSettingsProvider,
} from '@/mcp/server/createMcpActionEnablement';

function resolveLiveClientPermissionMode(
  client: HappyMcpSessionClient,
  metadataSnapshot?: Metadata | null,
): string | null {
  const mode = client.getPermissionMode?.()
    ?? metadataSnapshot?.permissionMode
    ?? null;
  return typeof mode === 'string' && mode.trim().length > 0 ? mode.trim() : null;
}

function resolveLiveClientBackendTarget(client: HappyMcpSessionClient): BackendTargetRefV1 | null {
  return client.getBackendTarget?.() ?? null;
}

function resolveLiveClientLocation(client: HappyMcpSessionClient): Readonly<{
  path?: string | null;
  host?: string | null;
  machineId?: string | null;
}> | null {
  return client.getCurrentSessionLocation?.() ?? null;
}

export function createHappierMcpServer(
  client: HappyMcpSessionClient,
  opts?: Readonly<{
    credentials?: Credentials | null;
    accountSettings?: AccountSettings | null;
    getAccountSettings?: (() => AccountSettings | null) | null;
  }>,
): { mcp: McpServer; toolNames: string[] } {
  // This server is the per-session MCP bridge that a running session agent uses.
  // It must use the `session_agent` surface so action enablement + approvals can be
  // configured separately from the external MCP surface (`mcp`).
  const toolSurface = 'session_agent' as const;
  const credentials = opts?.credentials ?? null;
  const actionSettingsProvider = createMcpActionSettingsProvider({
    accountSettings: opts?.accountSettings ?? null,
    getAccountSettings: opts?.getAccountSettings ?? null,
  });
  const readActionsSettings = () => actionSettingsProvider.getActionsSettings();
  const isActionEnabled = createMcpActionEnablement({
    actionSettingsProvider,
    surface: toolSurface,
  });
  const isActionApprovalRequired = createMcpActionApprovalRequirement({
    actionSettingsProvider,
    surface: toolSurface,
  });
  const ctx = credentials
    ? resolveSessionEncryptionContextFromCredentials(credentials)
    : { encryptionKey: new Uint8Array(0), encryptionVariant: 'legacy' as const };

  const mcp = new McpServer({
    name: 'Happier MCP',
    version: '1.0.0',
  });

  const sessionScopedRpc = async (method: string, params: unknown) =>
    await client.rpcHandlerManager.invokeLocal(method, params);
  const sessionMetadataSnapshot = client.getMetadataSnapshot?.() ?? null;
  const sessionLocation = resolveLiveClientLocation(client);
  const rawSession = sessionMetadataSnapshot || sessionLocation
    ? {
        ...(sessionMetadataSnapshot ? { metadata: sessionMetadataSnapshot } : {}),
        ...(typeof sessionLocation?.path === 'string' ? { path: sessionLocation.path } : {}),
        ...(typeof sessionLocation?.host === 'string' ? { host: sessionLocation.host } : {}),
        ...(typeof sessionLocation?.machineId === 'string' ? { machineId: sessionLocation.machineId } : {}),
      }
    : null;
  const executionRuns = {
    start: async (request: unknown) =>
      normalizeExecutionRunRpcPayload(
        await (client.executionRuns?.start?.(request) ?? sessionScopedRpc('execution.run.start', request)),
      ),
    list: async (request: unknown) =>
      normalizeExecutionRunRpcPayload(
        await (client.executionRuns?.list?.(request) ?? sessionScopedRpc('execution.run.list', request)),
      ),
    get: async (request: unknown) =>
      normalizeExecutionRunRpcPayload(
        await (client.executionRuns?.get?.(request) ?? sessionScopedRpc('execution.run.get', request)),
      ),
    send: async (request: unknown) =>
      normalizeExecutionRunRpcPayload(
        await (client.executionRuns?.send?.(request) ?? sessionScopedRpc('execution.run.send', request)),
      ),
    stop: async (request: unknown) =>
      normalizeExecutionRunRpcPayload(
        await (client.executionRuns?.stop?.(request) ?? sessionScopedRpc('execution.run.stop', request)),
      ),
    action: async (request: unknown) =>
      normalizeExecutionRunRpcPayload(
        await (client.executionRuns?.action?.(request) ?? sessionScopedRpc('execution.run.action', request)),
      ),
    wait: async (request: unknown) =>
      normalizeExecutionRunRpcPayload(
        await (client.executionRuns?.wait?.(request) ?? sessionScopedRpc('execution.run.wait', request)),
      ),
  };
  const runForSession = async (
    sessionId: string,
    operation: () => Promise<unknown>,
  ): Promise<unknown> => {
    if (sessionId !== client.sessionId) {
      return {
        ok: false,
        code: 'execution_run_target_unavailable',
        message: 'Cross-session execution run control is unavailable from a session-scoped MCP bridge',
      };
    }
    return await operation();
  };

  const harness = createCliActionExecutorHarness(
    {
      token: credentials?.token ?? '',
      ...(credentials ? { credentials } : {}),
      sessionId: client.sessionId,
      ctx,
      rawSession,
      getCallerPermissionMode: () => resolveLiveClientPermissionMode(client, sessionMetadataSnapshot),
      getCurrentSessionBackendTarget: () => resolveLiveClientBackendTarget(client),
    },
    {
      sessionWorkContextGet: async ({ sessionId }) => {
        if (sessionId !== client.sessionId) return { ok: false, errorCode: 'permission_denied', error: 'permission_denied' };
        if (!client.getMetadataSnapshot) return { ok: false, errorCode: 'unsupported_action', error: 'metadata_snapshot_unavailable' };
        const metadata = client.getMetadataSnapshot();
        if (!metadata) return { ok: false, errorCode: 'session_metadata_unavailable', error: 'session_metadata_unavailable' };
        return { ok: true, sessionId, context: readSessionWorkContextV1(metadata.sessionWorkContextV1) };
      },
      sessionWorkContextUpdate: async ({ sessionId, patch, tags }) => {
        if (sessionId !== client.sessionId) return { ok: false, errorCode: 'permission_denied', error: 'permission_denied' };
        if (!client.updateMetadataWithResult) return { ok: false, errorCode: 'unsupported_action', error: 'metadata_update_with_result_unavailable' };
        if (tags !== undefined && !credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        if (tags !== undefined && (!client.getMetadataSnapshot || !client.getMetadataVersionSnapshot || !client.refreshMetadataSnapshot)) {
          return { ok: false, errorCode: 'unsupported_action', error: 'metadata_snapshot_unavailable' };
        }
        try {
          const result = await client.updateMetadataWithResult((metadata) => {
            const applied = applySessionWorkContextPatchV1({ current: metadata.sessionWorkContextV1, patch, source: 'agent' });
            return { metadata: { ...metadata, sessionWorkContextV1: applied.context }, result: applied };
          });
          let tagResult: Awaited<ReturnType<typeof updateSessionWorkContextTags>> | null = null;
          if (tags !== undefined) {
            try {
              tagResult = await updateSessionWorkContextTags({
                sessionId, tags, credentials: credentials!, session: {
                  getMetadataSnapshot: () => client.getMetadataSnapshot!(),
                  getMetadataVersionSnapshot: () => client.getMetadataVersionSnapshot!(),
                  refreshMetadataSnapshot: async () => await client.refreshMetadataSnapshot!(),
                },
              });
            } catch (error) {
              return createSessionWorkContextTagsFailure({ error, sessionId, ...result });
            }
          }
          return { ok: true, sessionId, ...result, ...(tagResult ? { tagIds: tagResult.tagIds } : {}),
            skippedManualFields: [...result.skippedManualFields, ...(tagResult?.skippedManualFields ?? [])] };
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'session_metadata_unavailable') {
            return { ok: false, errorCode: 'session_metadata_unavailable', error: 'session_metadata_unavailable' };
          }
          return { ok: false, errorCode: 'metadata_update_failed', error: 'metadata_update_failed' };
        }
      },
      sessionTitleSet: async ({ sessionId, title }) => {
        const normalizedSessionId = String(sessionId ?? '').trim();
        if (!normalizedSessionId) {
          return { ok: false as const, errorCode: 'invalid_parameters' as const, error: 'invalid_parameters' as const };
        }
        const normalizedTitle = String(title ?? '').trim();
        if (!normalizedTitle) {
          return { ok: false as const, errorCode: 'invalid_parameters' as const, error: 'invalid_parameters' as const };
        }
        if (normalizedSessionId !== client.sessionId) {
          return { ok: false as const, errorCode: 'not_authenticated' as const, error: 'not_authenticated' as const };
        }

        try {
          await Promise.resolve(client.updateMetadata((current) => ({
            ...current,
            summary: {
              text: normalizedTitle,
              updatedAt: Date.now(),
            },
          })));
        } catch (error) {
          logger.debug('[mcp] Failed to update title metadata via session-scoped bridge', {
            sessionId: normalizedSessionId,
            error,
          });
          return { ok: false as const, errorCode: 'metadata_update_failed' as const, error: 'metadata_update_failed' as const };
        }

        return { ok: true as const, sessionId: normalizedSessionId, title: normalizedTitle };
      },
      executionRunStart: async (sessionId, request) => await runForSession(sessionId, async () => await executionRuns.start(request)),
      executionRunList: async (sessionId, request) => await runForSession(sessionId, async () => await executionRuns.list(request)),
      executionRunGet: async (sessionId, request) => await runForSession(sessionId, async () => await executionRuns.get(request)),
      executionRunSend: async (sessionId, request) => await runForSession(sessionId, async () => await executionRuns.send(request)),
      executionRunStop: async (sessionId, request) => await runForSession(sessionId, async () => await executionRuns.stop(request)),
      executionRunAction: async (sessionId, request) => await runForSession(sessionId, async () => await executionRuns.action(request)),
      executionRunWait: async (sessionId, request) => await runForSession(sessionId, async () => await executionRuns.wait(request)),

      ...createDaemonMemoryActionDeps({
        invoke: async ({ machineId, method, request }) => {
          const selectedMachineId = machineId.trim();
          const sessionMachineId = typeof sessionLocation?.machineId === 'string'
            ? sessionLocation.machineId.trim()
            : '';
          if (sessionMachineId && selectedMachineId === sessionMachineId) {
            return await sessionScopedRpc(method, request);
          }
          if (credentials) {
            return await callMachineRpc({
              credentials,
              machineId: selectedMachineId,
              method,
              request,
            });
          }
          if (sessionMachineId) {
            throw new Error('Cross-machine memory access requires authenticated machine RPC');
          }
          // Compatibility clients that do not expose a session machine and do not
          // provide credentials can only address their already-bound local daemon.
          return await sessionScopedRpc(method, request);
        },
      }),

      promptRegistryInstall: async (args) => {
        if (!args.installTarget) {
          return { ok: false as const, errorCode: 'invalid_request' as const, error: 'installTarget is required' };
        }

        const request = PromptRegistryInstallRequestV1Schema.parse({
          sourceId: args.sourceId,
          itemId: args.itemId,
          configuredSources: args.configuredSources ?? [],
          installTarget: args.installTarget,
        });
        const res = await sessionScopedRpc(RPC_METHODS.DAEMON_PROMPT_REGISTRY_INSTALL, request);
        return PromptRegistryInstallResponseV1Schema.parse(res);
      },

      resetGlobalVoiceAgent: async () => {},
      isActionEnabled: (id) => isActionEnabled(id),
      isActionApprovalRequired: (id) => isActionApprovalRequired(id),
    },
  );

  const executor = harness.executor;

  registerHappierMcpResources(mcp as any, {
    surface: toolSurface,
    isActionEnabled,
  });

  const actionToolBridge = createActionToolExecutorBridge({
    executor,
    isActionEnabled: (id) => {
      const spec = getActionSpec(id as any);
      return isActionSpecSurfacedOn(spec, toolSurface) && isActionEnabled(id as any);
    },
    surface: toolSurface,
    actionsSettings: readActionsSettings(),
    getActionsSettings: readActionsSettings,
    resolveCallerPermissionMode: () => resolveLiveClientPermissionMode(client, sessionMetadataSnapshot),
    defaultSessionMachineId: sessionLocation?.machineId ?? null,
  });

  const { toolNames } = registerHappierMcpBuiltInTools(mcp as any, {
    sessionId: client.sessionId,
    resolveSessionId: () => client.sessionId,
    defaultSessionMachineId: sessionLocation?.machineId ?? null,
    surface: toolSurface,
    actionsSettings: readActionsSettings(),
    getActionsSettings: readActionsSettings,
    deps: {
      changeTitle: createChangeTitleToolHandler({
        executor,
        surface: toolSurface,
        afterCommit: async ({ title }) => {
          // Keep the in-memory session metadata snapshot in sync so the UI / session agent
          // can reflect the new title immediately (without requiring a full server refresh).
          await Promise.resolve(client.updateMetadata((current) => ({
            ...current,
            summary: {
              text: title,
              updatedAt: Date.now(),
            },
          })));
        },
      }),
      startExecutionRun: createStartExecutionRunToolHandler({ executor, surface: toolSurface }),
      executeActionByToolName: actionToolBridge.executeActionByToolName,
      resolveActionOptions: (args) => actionToolBridge.resolveActionOptions(args, client.sessionId),
      isActionEnabled: actionToolBridge.isActionEnabled,
    },
  });

  return {
    mcp,
    toolNames,
  };
}
