import * as React from 'react';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { useSessionListRenderable } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent, getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { patchSessionWorkContextMetadata } from './sessionWorkContextMetadata';
import { SessionWorkContextEditorModal } from './SessionWorkContextEditorModal';
import type { SessionWorkContextV1, SessionWorkContextPatchV1 } from '@happier-dev/protocol';

type WorkContextField = 'tasks' | 'mergeRequests' | 'branch' | 'description';

export type SessionWorkContextSectionProps = Readonly<{
    sessionId: string;
    serverId: string | null;
    metadataVersion: number;
    context: SessionWorkContextV1 | null | undefined;
    tags?: readonly string[];
    canEdit: boolean;
    onEditTags?: (() => void) | null;
}>;

const FIELDS: ReadonlyArray<Readonly<{
    key: WorkContextField;
    title: WorkContextField;
}>> = [
    { key: 'tasks', title: 'tasks' },
    { key: 'mergeRequests', title: 'mergeRequests' },
    { key: 'branch', title: 'branch' },
    { key: 'description', title: 'description' },
];

function formatFieldValue(context: SessionWorkContextV1, field: WorkContextField): string {
    const value = context[field];
    if (Array.isArray(value)) return value.join('\n') || t('sessionInfo.workContext.notSet');
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : t('sessionInfo.workContext.notSet');
}

function returnToAutoButton(onPress: () => void, accessibilityLabel: string, linkColor: string, disabled: boolean) {
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            disabled={disabled}
            onPress={(event) => {
                event.stopPropagation?.();
                onPress();
            }}
            style={{ paddingHorizontal: 8, paddingVertical: 4 }}
        >
            <Text style={{ color: linkColor, fontSize: 12 }}>{t('sessionInfo.workContext.returnToAuto')}</Text>
        </Pressable>
    );
}

export const SessionWorkContextSection = React.memo(function SessionWorkContextSection(props: SessionWorkContextSectionProps) {
    const { theme } = useUnistyles();
    const sessionListRenderable = useSessionListRenderable(props.sessionId);
    const activeServerId = getActiveServerSnapshot().serverId;
    const isListProjectionForRouteServer = !props.serverId
        || !activeServerId
        || areServerProfileIdentifiersEquivalent(props.serverId, activeServerId);
    const projectedContext = sessionListRenderable?.metadata?.sessionWorkContextV1;
    const projectedContextIsComplete = projectedContext === null
        || (projectedContext?.v === 1 && Object.prototype.hasOwnProperty.call(projectedContext, 'manualOverrides'));
    const useNewerListProjection = isListProjectionForRouteServer
        && sessionListRenderable !== null
        && sessionListRenderable.metadataVersion > props.metadataVersion
        && projectedContextIsComplete;
    const contextValue = useNewerListProjection ? projectedContext : props.context;
    const context: SessionWorkContextV1 = contextValue?.v === 1 ? contextValue : { v: 1 };
    const manualFields = React.useMemo(
        () => Object.keys(context.manualOverrides ?? {}).filter((key) => context.manualOverrides?.[key] === true),
        [context.manualOverrides],
    );

    const save = React.useCallback((patch: SessionWorkContextPatchV1) => patchSessionWorkContextMetadata({
        sessionId: props.sessionId,
        serverId: props.serverId,
        patch,
    }), [props.serverId, props.sessionId]);
    const reset = React.useCallback((field: string) => patchSessionWorkContextMetadata({
        sessionId: props.sessionId,
        serverId: props.serverId,
        patch: {},
        resetManualFields: [field],
    }), [props.serverId, props.sessionId]);
    const resetFieldRef = React.useRef<string | null>(null);
    const [resetting, performReset] = useHappyAction(async () => {
        const field = resetFieldRef.current;
        if (field) await reset(field);
    });
    const requestReset = React.useCallback((field: string) => {
        resetFieldRef.current = field;
        performReset();
    }, [performReset]);

    const openEditor = React.useCallback(() => {
        if (!props.canEdit) return;
        Modal.show({
            component: SessionWorkContextEditorModal,
            props: {
                context,
                manualFields,
                onSave: save,
                onResetField: reset,
            },
            chrome: {
                kind: 'card',
                title: t('sessionInfo.workContext.title'),
                testID: 'session-work-context-editor',
                layout: 'fill',
                bodyScroll: 'auto',
                dimensions: { width: 560, maxHeightRatio: 0.92, size: 'lg' },
            },
            closeOnBackdrop: true,
        });
    }, [context, manualFields, props.canEdit, reset, save]);

    const renderReset = (field: string) => props.canEdit && manualFields.includes(field)
        ? returnToAutoButton(() => requestReset(field), t('sessionInfo.workContext.returnToAuto'), theme.colors.text.link, resetting)
        : undefined;

    const customKeys = [...new Set([
        ...Object.keys(context.customFields ?? {}),
        ...manualFields.filter((field) => field.startsWith('custom:')).map((field) => field.slice('custom:'.length)),
    ])].sort((a, b) => a.localeCompare(b));
    const tagsResetButton = renderReset('tags');

    return (
        <ItemGroup title={t('sessionInfo.workContext.title')}>
            {FIELDS.map(({ key, title }) => {
                const manual = manualFields.includes(key);
                const resetButton = renderReset(key);
                return (
                    <Item
                        key={key}
                        testID={`session-work-context-${key}`}
                        title={t(`sessionInfo.workContext.${title}`)}
                        subtitle={formatFieldValue(context, key)}
                        subtitleLines={0}
                        detail={manual ? t('sessionInfo.workContext.manual') : undefined}
                        icon={<Icon name={key === 'description' ? 'note-pencil' : 'git-branch'} size={29} color={theme.colors.accent.indigo} />}
                        rightElement={resetButton}
                        rightElementOutsidePressable={Boolean(resetButton)}
                        onPress={props.canEdit ? openEditor : undefined}
                        showChevron={props.canEdit}
                    />
                );
            })}
            {customKeys.map((key) => {
                const manualKey = `custom:${key}`;
                const manual = manualFields.includes(manualKey);
                const resetButton = renderReset(manualKey);
                return (
                    <Item
                        key={manualKey}
                        testID={`session-work-context-custom-${key}`}
                        title={key}
                        subtitle={context.customFields?.[key]?.trim() || t('sessionInfo.workContext.notSet')}
                        detail={manual ? t('sessionInfo.workContext.manual') : undefined}
                        icon={<Icon name="tag" size={29} color={theme.colors.accent.indigo} />}
                        rightElement={resetButton}
                        rightElementOutsidePressable={Boolean(resetButton)}
                        onPress={props.canEdit ? openEditor : undefined}
                        showChevron={props.canEdit}
                    />
                );
            })}
            {manualFields.includes('tags') ? (
                <Item
                    testID="session-work-context-tags"
                    title={t('sessionInfo.workContext.tags')}
                    subtitle={props.tags?.length ? props.tags.join(', ') : t('sessionInfo.workContext.notSet')}
                    detail={t('sessionInfo.workContext.manual')}
                    icon={<Icon name="tag" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={tagsResetButton}
                    rightElementOutsidePressable={Boolean(tagsResetButton)}
                    onPress={props.canEdit ? props.onEditTags ?? undefined : undefined}
                    showChevron={props.canEdit && Boolean(props.onEditTags)}
                />
            ) : null}
        </ItemGroup>
    );
});
