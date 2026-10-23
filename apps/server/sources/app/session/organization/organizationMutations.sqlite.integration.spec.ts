import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { setSessionTagAssignments, setSessionTagAssignmentsInTx } from "./organizationMutations";

describe("session organization mutations on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-organization-sqlite-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
            env: { HAPPIER_SQLITE_CONNECTION_LIMIT: "2" },
        });
    });

    beforeEach(() => {
        harness.resetEnv();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("persists tag assignments through the real SQLite Prisma client", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            },
            select: { id: true },
        });
        const [firstTag, secondTag] = await Promise.all([
            db.sessionOrganizationTag.create({
                data: {
                    accountId: account.id,
                    tagKey: `tag-${randomUUID()}`,
                    tagHash: `tag-hash-${randomUUID()}`,
                },
                select: { id: true },
            }),
            db.sessionOrganizationTag.create({
                data: {
                    accountId: account.id,
                    tagKey: `tag-${randomUUID()}`,
                    tagHash: `tag-hash-${randomUUID()}`,
                },
                select: { id: true },
            }),
        ]);

        const result = await setSessionTagAssignments({
            accountId: account.id,
            sessionId: session.id,
            request: { tagIds: [firstTag.id, secondTag.id] },
        });

        expect(result).toEqual({
            sessionId: session.id,
            tagIds: [firstTag.id, secondTag.id].sort(),
        });
        await expect(
            db.sessionTagAssignment.findMany({
                where: { accountId: account.id, sessionId: session.id },
                orderBy: { tagId: "asc" },
                select: { tagId: true },
            }),
        ).resolves.toEqual([
            { tagId: firstTag.id },
            { tagId: secondTag.id },
        ].sort((left, right) => left.tagId.localeCompare(right.tagId)));
        await expect(
            db.sessionOrganizationCheckpoint.findUnique({
                where: { accountId: account.id },
                select: { version: true },
            }),
        ).resolves.toEqual({ version: 1 });

        // Agents append to the canonical assignments; retries must preserve manual tags.
        await setSessionTagAssignments({ accountId: account.id, sessionId: session.id, request: { tagIds: [firstTag.id] } });
        const beforeAdd = await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { metadataVersion: true, updatedAt: true } });
        const addRequest = { tagIds: [secondTag.id, secondTag.id], mode: "add" as const, expectedMetadataVersion: 0 };
        await expect(setSessionTagAssignments({ accountId: account.id, sessionId: session.id, request: addRequest }))
            .resolves.toEqual({ sessionId: session.id, tagIds: [firstTag.id, secondTag.id].sort() });
        await expect(setSessionTagAssignments({ accountId: account.id, sessionId: session.id, request: addRequest }))
            .resolves.toEqual({ sessionId: session.id, tagIds: [firstTag.id, secondTag.id].sort() });

        await expect(db.session.findUniqueOrThrow({ where: { id: session.id }, select: { metadataVersion: true, updatedAt: true } }))
            .resolves.toEqual(beforeAdd);

        // A manual metadata CAS lands before replacing tags. A stale agent is fenced out.
        await db.session.update({ where: { id: session.id }, data: { metadataVersion: 1, metadata: JSON.stringify({ sessionWorkContextV1: { v: 1, manualOverrides: { tags: true } } }) } });
        await setSessionTagAssignments({ accountId: account.id, sessionId: session.id, request: { tagIds: [firstTag.id] } });
        await expect(setSessionTagAssignments({ accountId: account.id, sessionId: session.id, request: addRequest }))
            .resolves.toEqual({ error: "metadata-version-conflict", currentMetadataVersion: 1 });
        await expect(db.sessionTagAssignment.findMany({ where: { accountId: account.id, sessionId: session.id }, select: { tagId: true } }))
            .resolves.toEqual([{ tagId: firstTag.id }]);

        // Exercise the opposite order through real competing SQLite transactions:
        // an agent holding the session row lock, then the user's CAS and replace.
        await db.session.update({ where: { id: session.id }, data: { metadataVersion: 2, metadata: "{}" } });
        let signalAdded!: () => void;
        let releaseAdd!: () => void;
        const added = new Promise<void>((resolve) => { signalAdded = resolve; });
        const holdAdd = new Promise<void>((resolve) => { releaseAdd = resolve; });
        const agent = inTx(async (tx) => {
            const result = await setSessionTagAssignmentsInTx(tx, { accountId: account.id, sessionId: session.id, request: { ...addRequest, expectedMetadataVersion: 2 } });
            signalAdded();
            await holdAdd;
            return result;
        });
        await Promise.race([added, agent]);
        const manualMarker = db.session.updateMany({ where: { id: session.id, metadataVersion: 2 }, data: { metadataVersion: 3, metadata: JSON.stringify({ sessionWorkContextV1: { v: 1, manualOverrides: { tags: true } } }) } }).then((result) => result);
        releaseAdd();
        await expect(agent).resolves.toEqual({ sessionId: session.id, tagIds: [firstTag.id, secondTag.id].sort() });
        await expect(manualMarker).resolves.toEqual({ count: 1 });
        await setSessionTagAssignments({ accountId: account.id, sessionId: session.id, request: { tagIds: [firstTag.id] } });
        await expect(db.sessionTagAssignment.findMany({ where: { accountId: account.id, sessionId: session.id }, select: { tagId: true } }))
            .resolves.toEqual([{ tagId: firstTag.id }]);
    });
});
