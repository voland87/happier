import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from '@/components/sessions/shell/sessionShellTestHelpers';
import type { SessionWorkContextV1 } from '@happier-dev/protocol';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionShellCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
});

function findElementByTestID(node: unknown, testID: string): React.ReactElement<any> | null {
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = findElementByTestID(child, testID);
            if (found) return found;
        }
        return null;
    }
    if (!React.isValidElement(node)) return null;
    if ((node.props as any)?.testID === testID) return node;
    return findElementByTestID((node.props as any)?.children, testID);
}

async function pressModalButton(chrome: any, testID: string): Promise<void> {
    const target = findElementByTestID(chrome?.footer, testID);
    if (!target) throw new Error(`Unable to find modal footer button ${testID}`);
    await act(async () => {
        await target.props.onPress();
    });
}

describe('SessionWorkContextEditorModal', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        standardCleanup();
    });

    async function renderEditor(params: Readonly<{
        context?: SessionWorkContextV1;
        manualFields?: string[];
        onSave?: (patch: any) => Promise<void>;
        onResetField?: (field: string) => Promise<void>;
        onClose?: () => void;
    }> = {}) {
        const { SessionWorkContextEditorModal } = await import('./SessionWorkContextEditorModal');
        let chrome: any = null;
        const screen = await renderScreen(<SessionWorkContextEditorModal
            setChrome={(next) => { chrome = next; }}
            onClose={params.onClose ?? vi.fn()}
            context={params.context ?? { v: 1 }}
            manualFields={params.manualFields ?? []}
            onSave={params.onSave ?? vi.fn(async () => undefined)}
            onResetField={params.onResetField ?? vi.fn(async () => undefined)}
        />);
        return { screen, chrome: () => chrome };
    }

    it('saves only changed fields while leaving cleared custom lock tombstones editable', async () => {
        const onSave = vi.fn(async () => undefined);
        const context: SessionWorkContextV1 = {
            v: 1,
            tasks: ['TASK-1'],
            customFields: { team: 'platform' },
            manualOverrides: { 'custom:cleared': true },
        };
        const { screen, chrome } = await renderEditor({ context, onSave });
        const tasks = screen.findByTestId('work-context-input-tasks');
        if (!tasks) throw new Error('Expected tasks input');

        await act(async () => tasks.props.onChangeText('TASK-1\nhttps://tracker.example/2'));
        await pressModalButton(chrome(), 'work-context-save');

        expect(onSave).toHaveBeenCalledWith({ tasks: ['TASK-1', 'https://tracker.example/2'] });
    });

    it('clears an existing custom value explicitly and permits a blank locked tombstone', async () => {
        const onSave = vi.fn(async () => undefined);
        const context: SessionWorkContextV1 = {
            v: 1,
            customFields: { team: 'platform' },
            manualOverrides: { 'custom:cleared': true },
        };
        const { screen, chrome } = await renderEditor({ context, onSave });
        const teamValue = screen.findByTestId('work-context-custom-value-custom-1');
        if (!teamValue) throw new Error('Expected custom value input');

        await act(async () => teamValue.props.onChangeText(''));
        await pressModalButton(chrome(), 'work-context-save');

        expect(onSave).toHaveBeenCalledWith({ customFields: { team: null } });
    });

    it('deletes and adds custom fields in the same save', async () => {
        const onSave = vi.fn(async () => undefined);
        const { screen, chrome } = await renderEditor({
            context: { v: 1, customFields: { team: 'platform' } },
            onSave,
        });

        await screen.pressByTestIdAsync('work-context-delete-custom-custom-0');
        await screen.pressByTestIdAsync('work-context-add-custom');
        const name = screen.findByTestId('work-context-custom-key-custom-new-1');
        const value = screen.findByTestId('work-context-custom-value-custom-new-1');
        if (!name || !value) throw new Error('Expected new custom field inputs');
        await act(async () => {
            name.props.onChangeText('owner');
            value.props.onChangeText('alice');
        });
        await pressModalButton(chrome(), 'work-context-save');

        expect(onSave).toHaveBeenCalledWith({ customFields: { team: null, owner: 'alice' } });
    });

    it('preserves both values when swapping custom field names', async () => {
        const onSave = vi.fn(async () => undefined);
        const { screen, chrome } = await renderEditor({
            context: { v: 1, customFields: { a: 'value A', b: 'value B' } },
            onSave,
        });
        const firstKey = screen.findByTestId('work-context-custom-key-custom-0');
        const secondKey = screen.findByTestId('work-context-custom-key-custom-1');
        if (!firstKey || !secondKey) throw new Error('Expected both custom field key inputs');

        await act(async () => {
            firstKey.props.onChangeText('b');
            secondKey.props.onChangeText('a');
        });
        await pressModalButton(chrome(), 'work-context-save');

        expect(onSave).toHaveBeenCalledWith({ customFields: { a: 'value B', b: 'value A' } });
    });

    it('preserves values when renaming custom fields in a chain', async () => {
        const onSave = vi.fn(async () => undefined);
        const { screen, chrome } = await renderEditor({
            context: { v: 1, customFields: { a: 'value A', b: 'value B' } },
            onSave,
        });
        const firstKey = screen.findByTestId('work-context-custom-key-custom-0');
        const secondKey = screen.findByTestId('work-context-custom-key-custom-1');
        if (!firstKey || !secondKey) throw new Error('Expected both custom field key inputs');

        await act(async () => {
            firstKey.props.onChangeText('b');
            secondKey.props.onChangeText('c');
        });
        await pressModalButton(chrome(), 'work-context-save');

        expect(onSave).toHaveBeenCalledWith({ customFields: { a: null, b: 'value A', c: 'value B' } });
    });

    it('keeps edited input and displays a failure when saving is rejected', async () => {
        const onSave = vi.fn(async () => { throw new Error('offline'); });
        const onClose = vi.fn();
        const { screen, chrome } = await renderEditor({ onSave, onClose });
        const branch = screen.findByTestId('work-context-input-branch');
        if (!branch) throw new Error('Expected branch input');

        await act(async () => branch.props.onChangeText('feature/kept'));
        await pressModalButton(chrome(), 'work-context-save');

        expect(onSave).toHaveBeenCalledWith({ branch: 'feature/kept' });
        expect(screen.findByTestId('work-context-input-branch')?.props.value).toBe('feature/kept');
        expect(screen.findByTestId('work-context-error')).toBeTruthy();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('offers return-to-automatic for a cleared custom field lock', async () => {
        const onResetField = vi.fn(async () => undefined);
        const context: SessionWorkContextV1 = {
            v: 1,
            manualOverrides: { 'custom:cleared': true },
        };
        const { screen } = await renderEditor({ context, manualFields: ['custom:cleared'], onResetField });

        await screen.pressByTestIdAsync('work-context-reset-custom-cleared');

        expect(onResetField).toHaveBeenCalledWith('custom:cleared');
    });
});
