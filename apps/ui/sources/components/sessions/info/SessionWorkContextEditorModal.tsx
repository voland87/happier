import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { SessionWorkContextPatchV1, SessionWorkContextV1 } from '@happier-dev/protocol';

type CustomFieldDraft = Readonly<{
    id: string;
    originalKey: string | null;
    key: string;
    value: string;
}>;

export type SessionWorkContextEditorModalProps = CustomModalInjectedProps & Readonly<{
    context: SessionWorkContextV1;
    manualFields: readonly string[];
    onSave: (patch: SessionWorkContextPatchV1) => Promise<void>;
    onResetField: (field: string) => Promise<void>;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    content: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 16,
        gap: 12,
    },
    field: {
        gap: 6,
    },
    fieldHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
    label: {
        color: theme.colors.text.primary,
        fontSize: 13,
        ...Typography.default('semiBold'),
    },
    manual: {
        color: theme.colors.text.secondary,
        fontSize: 11,
        ...Typography.default(),
    },
    input: {
        minHeight: 42,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 9,
        color: theme.colors.text.primary,
        backgroundColor: theme.colors.input.background,
    },
    multilineInput: {
        minHeight: 86,
        textAlignVertical: 'top' as const,
    },
    customRow: {
        gap: 8,
        padding: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
    },
    customInputs: {
        flexDirection: 'row',
        gap: 8,
    },
    customKeyInput: {
        flex: 1,
        minWidth: 80,
    },
    customValueInput: {
        flex: 2,
        minWidth: 100,
    },
    customActions: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
    error: {
        color: theme.colors.state.danger.foreground,
        fontSize: 12,
        ...Typography.default(),
    },
    footer: {
        paddingHorizontal: 12,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
    footerActions: {
        flexDirection: 'row',
        gap: 8,
    },
    button: {
        minHeight: 36,
        justifyContent: 'center',
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset ?? theme.colors.input.background,
    },
    primaryButton: {
        borderColor: theme.colors.text.link,
    },
    smallButton: {
        minHeight: 28,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderColor: 'transparent',
        backgroundColor: 'transparent',
    },
    buttonText: {
        color: theme.colors.text.primary,
        fontSize: 12,
        ...Typography.default(),
    },
    buttonTextPrimary: {
        color: theme.colors.text.link,
        ...Typography.default('semiBold'),
    },
    disabled: {
        opacity: 0.55,
    },
}));

function createCustomFieldDrafts(context: SessionWorkContextV1): CustomFieldDraft[] {
    const keys = new Set(Object.keys(context.customFields ?? {}));
    for (const field of Object.keys(context.manualOverrides ?? {})) {
        if (field.startsWith('custom:')) keys.add(field.slice('custom:'.length));
    }
    return [...keys].sort((a, b) => a.localeCompare(b)).map((key, index) => ({
        id: `custom-${index}`,
        originalKey: key,
        key,
        value: context.customFields?.[key] ?? '',
    }));
}

function splitLines(value: string): string[] {
    return value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
}

function normalizedScalar(value: string): string | null {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function EditorButton(props: Readonly<{
    label: string;
    onPress: () => void;
    disabled?: boolean;
    primary?: boolean;
    testID?: string;
    small?: boolean;
}>) {
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.label}
            disabled={props.disabled}
            onPress={props.onPress}
            style={[
                stylesheet.button,
                props.primary ? stylesheet.primaryButton : null,
                props.small ? stylesheet.smallButton : null,
                props.disabled ? stylesheet.disabled : null,
            ]}
        >
            <Text style={[stylesheet.buttonText, props.primary ? stylesheet.buttonTextPrimary : null]}>
                {props.label}
            </Text>
        </Pressable>
    );
}

export function SessionWorkContextEditorModal(props: SessionWorkContextEditorModalProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [tasks, setTasks] = React.useState((props.context.tasks ?? []).join('\n'));
    const [mergeRequests, setMergeRequests] = React.useState((props.context.mergeRequests ?? []).join('\n'));
    const [branch, setBranch] = React.useState(props.context.branch ?? '');
    const [description, setDescription] = React.useState(props.context.description ?? '');
    const [customFields, setCustomFields] = React.useState(() => createCustomFieldDrafts(props.context));
    const [manualFields, setManualFields] = React.useState(() => new Set(props.manualFields));
    const [nextCustomId, setNextCustomId] = React.useState(customFields.length);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const updateCustomField = React.useCallback((id: string, update: Partial<Pick<CustomFieldDraft, 'key' | 'value'>>) => {
        setCustomFields((current) => current.map((field) => field.id === id ? { ...field, ...update } : field));
        setError(null);
    }, []);

    const resetField = React.useCallback(async (field: string) => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            await props.onResetField(field);
            setManualFields((current) => {
                const next = new Set(current);
                next.delete(field);
                return next;
            });
        } catch {
            setError(t('sessionInfo.workContext.saveFailed'));
        } finally {
            setBusy(false);
        }
    }, [busy, props]);

    const save = React.useCallback(async () => {
        if (busy) return;
        const patch: SessionWorkContextPatchV1 = {};
        const nextTasks = splitLines(tasks);
        const nextMergeRequests = splitLines(mergeRequests);
        if (!sameStringArray(props.context.tasks ?? [], nextTasks)) patch.tasks = nextTasks;
        if (!sameStringArray(props.context.mergeRequests ?? [], nextMergeRequests)) patch.mergeRequests = nextMergeRequests;
        const nextBranch = normalizedScalar(branch);
        const nextDescription = normalizedScalar(description);
        if ((props.context.branch ?? null) !== nextBranch) patch.branch = nextBranch;
        if ((props.context.description ?? null) !== nextDescription) patch.description = nextDescription;

        const initialCustomKeys = new Set([
            ...Object.keys(props.context.customFields ?? {}),
            ...Object.keys(props.context.manualOverrides ?? {})
                .filter((field) => field.startsWith('custom:'))
                .map((field) => field.slice('custom:'.length)),
        ]);
        const currentOriginalKeys = new Set(customFields.flatMap((field) => field.originalKey ? [field.originalKey] : []));
        const customPatch: Record<string, string | null> = {};
        const submittedKeys = new Set<string>();
        for (const field of customFields) {
            const key = field.key.trim();
            const value = field.value.trim();
            if (!key && !value) {
                if (field.originalKey) customPatch[field.originalKey] = null;
                continue;
            }
            if (!key || (!value && !field.originalKey)) {
                setError(t('sessionInfo.workContext.customFieldIncomplete'));
                return;
            }
            if (submittedKeys.has(key)) {
                setError(t('sessionInfo.workContext.customFieldDuplicate'));
                return;
            }
            submittedKeys.add(key);
            if (field.originalKey && field.originalKey !== key) customPatch[field.originalKey] = null;
        }
        for (const key of initialCustomKeys) {
            if (!currentOriginalKeys.has(key)) customPatch[key] = null;
        }
        for (const field of customFields) {
            const key = field.key.trim();
            const value = field.value.trim();
            if (!key) continue;
            if (field.originalKey !== key || (props.context.customFields?.[key] ?? '') !== value) {
                customPatch[key] = value || null;
            }
        }
        if (Object.keys(customPatch).length > 0) patch.customFields = customPatch;
        if (Object.keys(patch).length === 0) {
            props.onClose();
            return;
        }

        setBusy(true);
        setError(null);
        try {
            await props.onSave(patch);
            props.onClose();
        } catch {
            setError(t('sessionInfo.workContext.saveFailed'));
        } finally {
            setBusy(false);
        }
    }, [branch, busy, customFields, description, mergeRequests, props, tasks]);

    const addCustomField = React.useCallback(() => {
        setCustomFields((current) => [...current, {
            id: `custom-new-${nextCustomId}`,
            originalKey: null,
            key: '',
            value: '',
        }]);
        setNextCustomId((current) => current + 1);
        setError(null);
    }, [nextCustomId]);

    const deleteCustomField = React.useCallback((id: string) => {
        setCustomFields((current) => current.filter((field) => field.id !== id));
        setError(null);
    }, []);

    const renderField = (
        key: 'tasks' | 'mergeRequests' | 'branch' | 'description',
        label: string,
        value: string,
        onChange: (value: string) => void,
        multiline: boolean = false,
    ) => (
        <View key={key} style={styles.field}>
            <View style={styles.fieldHeader}>
                <Text style={styles.label}>{label}</Text>
                {manualFields.has(key) ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={styles.manual}>{t('sessionInfo.workContext.manual')}</Text>
                        <EditorButton label={t('sessionInfo.workContext.returnToAuto')} small={true} disabled={busy} onPress={() => void resetField(key)} testID={`work-context-reset-${key}`} />
                    </View>
                ) : null}
            </View>
            <TextInput
                testID={`work-context-input-${key}`}
                accessibilityLabel={label}
                style={[styles.input, multiline ? styles.multilineInput : null, Typography.default()]}
                value={value}
                placeholder={key === 'tasks' || key === 'mergeRequests' ? t('sessionInfo.workContext.referencePlaceholder') : undefined}
                placeholderTextColor={theme.colors.input.placeholder}
                onChangeText={(next) => { onChange(String(next)); setError(null); }}
                multiline={multiline}
                autoCapitalize="none"
                autoCorrect={false}
            />
        </View>
    );

    const footer = React.useMemo(() => (
        <View style={styles.footer}>
            <EditorButton label={t('common.cancel')} disabled={busy} onPress={props.onClose} testID="work-context-cancel" />
            <View style={styles.footerActions}>
                <EditorButton label={t('common.save')} disabled={busy} primary={true} onPress={save} testID="work-context-save" />
            </View>
        </View>
    ), [busy, props.onClose, save, styles.footer]);

    const chrome = React.useMemo(() => ({ kind: 'card' as const, footer }), [footer]);
    useModalCardChrome(props.setChrome, chrome);

    return (
        <View style={{ flex: 1, minHeight: 0 }}>
            <View style={styles.content}>
                {renderField('tasks', t('sessionInfo.workContext.tasks'), tasks, setTasks, true)}
                {renderField('mergeRequests', t('sessionInfo.workContext.mergeRequests'), mergeRequests, setMergeRequests, true)}
                {renderField('branch', t('sessionInfo.workContext.branch'), branch, setBranch)}
                {renderField('description', t('sessionInfo.workContext.description'), description, setDescription, true)}
                <View style={styles.field}>
                    <Text style={styles.label}>{t('sessionInfo.workContext.customFields')}</Text>
                    {customFields.map((field) => {
                        const manualKey = `custom:${field.originalKey ?? field.key.trim()}`;
                        return (
                            <View key={field.id} style={styles.customRow}>
                                {field.originalKey && manualFields.has(`custom:${field.originalKey}`) ? (
                                    <View style={styles.fieldHeader}>
                                        <Text style={styles.manual}>{t('sessionInfo.workContext.manual')}</Text>
                                        <EditorButton
                                            label={t('sessionInfo.workContext.returnToAuto')}
                                            small={true}
                                            disabled={busy}
                                            onPress={() => void resetField(`custom:${field.originalKey}`)}
                                            testID={`work-context-reset-custom-${field.originalKey}`}
                                        />
                                    </View>
                                ) : null}
                                <View style={styles.customInputs}>
                                    <TextInput
                                        testID={`work-context-custom-key-${field.id}`}
                                        accessibilityLabel={t('sessionInfo.workContext.customFieldNamePlaceholder')}
                                        style={[styles.input, styles.customKeyInput, Typography.default()]}
                                        value={field.key}
                                        placeholder={t('sessionInfo.workContext.customFieldNamePlaceholder')}
                                        placeholderTextColor={theme.colors.input.placeholder}
                                        onChangeText={(value) => updateCustomField(field.id, { key: String(value) })}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                    />
                                    <TextInput
                                        testID={`work-context-custom-value-${field.id}`}
                                        accessibilityLabel={t('sessionInfo.workContext.customFieldValuePlaceholder')}
                                        style={[styles.input, styles.customValueInput, Typography.default()]}
                                        value={field.value}
                                        placeholder={t('sessionInfo.workContext.customFieldValuePlaceholder')}
                                        placeholderTextColor={theme.colors.input.placeholder}
                                        onChangeText={(value) => updateCustomField(field.id, { value: String(value) })}
                                    />
                                </View>
                                <View style={styles.customActions}>
                                    {manualFields.has(manualKey) && !field.originalKey ? (
                                        <EditorButton label={t('sessionInfo.workContext.returnToAuto')} small={true} disabled={busy} onPress={() => void resetField(manualKey)} />
                                    ) : <View />}
                                    <EditorButton
                                        label={t('sessionInfo.workContext.deleteCustomField')}
                                        small={true}
                                        disabled={busy}
                                        onPress={() => deleteCustomField(field.id)}
                                        testID={`work-context-delete-custom-${field.id}`}
                                    />
                                </View>
                            </View>
                        );
                    })}
                    <View style={{ alignItems: 'flex-start' }}>
                        <EditorButton label={t('sessionInfo.workContext.addCustomField')} small={true} disabled={busy} onPress={addCustomField} testID="work-context-add-custom" />
                    </View>
                </View>
                {error ? <Text testID="work-context-error" style={styles.error}>{error}</Text> : null}
            </View>
        </View>
    );
}
