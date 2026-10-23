import { z } from 'zod';

export function createSessionWorkContextV1Schema(zod: typeof z) {
  return zod.object({
    v: zod.literal(1),
    tasks: zod.array(zod.string()).optional(),
    mergeRequests: zod.array(zod.string()).optional(),
    branch: zod.string().optional(),
    repository: zod.string().optional(),
    description: zod.string().optional(),
    customFields: zod.record(zod.string(), zod.string()).optional(),
    manualOverrides: zod.record(zod.string(), zod.literal(true)).optional(),
  }).passthrough();
}

export const SessionWorkContextV1Schema = createSessionWorkContextV1Schema(z);
export type SessionWorkContextV1 = z.infer<typeof SessionWorkContextV1Schema>;

// Agent-facing patches intentionally cannot change provenance or user locks.
export const SessionWorkContextPatchV1Schema = z.object({
  tasks: z.array(z.string()).nullable().optional(),
  mergeRequests: z.array(z.string()).nullable().optional(),
  branch: z.string().nullable().optional(),
  repository: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  customFields: z.record(z.string(), z.string().nullable()).optional(),
}).strict();
export type SessionWorkContextPatchV1 = z.infer<typeof SessionWorkContextPatchV1Schema>;

export function readSessionWorkContextV1(value: unknown): SessionWorkContextV1 | null {
  const parsed = SessionWorkContextV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function normalizedList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function applySessionWorkContextPatchV1(params: Readonly<{
  current: unknown;
  patch: SessionWorkContextPatchV1;
  source: 'user' | 'agent';
  resetManualFields?: readonly string[];
  lockManualFields?: readonly string[];
}>): { context: SessionWorkContextV1; skippedManualFields: string[] } {
  const context: SessionWorkContextV1 = { ...(readSessionWorkContextV1(params.current) ?? { v: 1 }) };
  const manualOverrides = { ...context.manualOverrides };
  const skippedManualFields: string[] = [];
  const mark = (field: string) => Object.defineProperty(manualOverrides, field, { value: true, enumerable: true, configurable: true, writable: true });
  if (params.source === 'user') {
    for (const field of params.resetManualFields ?? []) delete manualOverrides[field];
    for (const field of params.lockManualFields ?? []) mark(field);
  }
  const canApply = (field: string): boolean => {
    if (params.source === 'agent' && manualOverrides[field] === true) {
      skippedManualFields.push(field);
      return false;
    }
    if (params.source === 'user') mark(field);
    return true;
  };
  for (const field of ['tasks', 'mergeRequests'] as const) {
    const value = params.patch[field];
    if (value === undefined || !canApply(field)) continue;
    const next = normalizedList(value === null ? [] : [
      ...(params.source === 'agent' ? context[field] ?? [] : []), ...value,
    ]);
    if (next.length) context[field] = next;
    else delete context[field];
  }
  for (const field of ['branch', 'repository', 'description'] as const) {
    const value = params.patch[field];
    if (value === undefined || !canApply(field)) continue;
    const next = value?.trim();
    if (next) context[field] = next;
    else delete context[field];
  }
  if (params.patch.customFields !== undefined) {
    const customFields = { ...context.customFields };
    for (const [key, value] of Object.entries(params.patch.customFields)) {
      if (!canApply(`custom:${key}`)) continue;
      const next = value?.trim();
      if (next) Object.defineProperty(customFields, key, { value: next, enumerable: true, configurable: true, writable: true });
      else delete customFields[key];
    }
    if (Object.keys(customFields).length) context.customFields = customFields;
    else delete context.customFields;
  }
  if (Object.keys(manualOverrides).length) context.manualOverrides = manualOverrides;
  else delete context.manualOverrides;
  return { context, skippedManualFields };
}
