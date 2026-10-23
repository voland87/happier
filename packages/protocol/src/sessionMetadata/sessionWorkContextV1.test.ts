import { describe, expect, it } from 'vitest';
import { applySessionWorkContextPatchV1, readSessionWorkContextV1, SessionWorkContextPatchV1Schema } from './sessionWorkContextV1.js';

describe('session work context', () => {
  it('normalizes confirmed facts, appends agent links and preserves future fields', () => {
    const { context } = applySessionWorkContextPatchV1({
      current: { v: 1, tasks: [' TASK-1 '], future: { keep: true } },
      patch: { tasks: ['TASK-1', ' TASK-2 ', ''], branch: ' feature/context ' }, source: 'agent',
    });
    expect(context).toEqual({ v: 1, tasks: ['TASK-1', 'TASK-2'], branch: 'feature/context', future: { keep: true } });
    expect(readSessionWorkContextV1({ v: 2 })).toBeNull();
    expect(readSessionWorkContextV1(undefined)).toBeNull();
    expect(applySessionWorkContextPatchV1({ current: context, patch: { tasks: [] }, source: 'agent' }).context.tasks).toEqual(['TASK-1', 'TASK-2']);
    expect(applySessionWorkContextPatchV1({ current: context, patch: { tasks: null }, source: 'agent' }).context.tasks).toBeUndefined();
  });

  it('keeps user replacements and explicit clears locked against agent updates', () => {
    const user = applySessionWorkContextPatchV1({ current: { v: 1, tasks: ['old'], branch: 'old' },
      patch: { tasks: ['chosen'], branch: ' ', customFields: { owner: 'me', removed: null } }, source: 'user' });
    const agent = applySessionWorkContextPatchV1({ current: user.context,
      patch: { tasks: ['new'], branch: 'new', customFields: { owner: 'agent', removed: 'new', priority: 'high' } },
      source: 'agent', resetManualFields: ['tasks', 'branch', 'custom:owner'], lockManualFields: ['description'] });
    expect(agent.context).toEqual({ v: 1, tasks: ['chosen'], customFields: { owner: 'me', priority: 'high' },
      manualOverrides: { tasks: true, branch: true, 'custom:owner': true, 'custom:removed': true } });
    expect(agent.skippedManualFields).toEqual(['tasks', 'branch', 'custom:owner', 'custom:removed']);
  });

  it('resets only named locks, retaining their values, and supports per-field lock markers', () => {
    const current = { v: 1, description: 'mine', manualOverrides: { description: true, tags: true } };
    const reset = applySessionWorkContextPatchV1({ current, patch: {}, source: 'user', resetManualFields: ['description'], lockManualFields: ['repository'] });
    expect(reset.context).toEqual({ v: 1, description: 'mine', manualOverrides: { tags: true, repository: true } });
    expect(applySessionWorkContextPatchV1({ current: reset.context, patch: { description: 'confirmed' }, source: 'agent' }).context.description).toBe('confirmed');
  });

  it('clears list/scalar/custom values without losing unknown properties or user locks', () => {
    const { context } = applySessionWorkContextPatchV1({ current: { v: 1, branch: 'old', tasks: ['old'], customFields: { a: 'a', b: 'b' }, extra: 42 },
      patch: { branch: null, tasks: null, customFields: { a: null } }, source: 'user' });
    expect(context).toEqual({ v: 1, customFields: { b: 'b' }, extra: 42, manualOverrides: { branch: true, tasks: true, 'custom:a': true } });
    expect(SessionWorkContextPatchV1Schema.safeParse({ source: 'user', manualOverrides: { branch: true } }).success).toBe(false);
  });
});
