// `/evidence delete` ハンドラの検証(goal-management task 3.4 / Req 3.1, 3.3, 3.4, 3.5, 4.4)。
//
// 完了条件: 所有証跡の削除で `deleteEvidence` 経由に証跡が消え、ephemeral 削除完了応答
// (mode:"reply", ephemeral:true)が返る。不存在 id / 非所有(別 user_id)はいずれも同一の
// 「見つからない」ephemeral 応答(露出防止)を返し、対象を削除しない。応答は全て ephemeral。
//
// 方針: DO を起動せず、実 SQLite を `CycleDataAuthority` に async ラップしたアダプタを
// routing モック(getUserCycleAuthority)経由でハンドラへ供給して単体検証する
// (実 DO 統合は別タスク)。実行環境: vitest projects の "node" プロジェクト。
// 参考: test/goal-management-cycle-create-handler.test.ts(routing モック・ctx 構築)、
// test/goal-management-delete-evidence.test.ts(実 SQLite authority・FULL_ROWS)。

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscordEnv } from "../src/discord/env";
import type { InteractionContext } from "../src/discord/types";
import {
  EVIDENCE_COMMAND_NAME,
  EVIDENCE_DELETE_SUBCOMMAND,
  EVIDENCE_OPT_ID,
} from "../src/goal-management/commands";
import type { CycleDataAuthority } from "../src/goal-management/domain/cycle-operations";
import { runMigrations } from "../src/persistence/migrator";
import { createRepository } from "../src/persistence/repository";
import type { EntityName, EntityRow, EvidenceRow } from "../src/types";
import { NodeSqliteBackend } from "./helpers/node-sqlite-adapter";

// routing をモックして DO 起動を避け、in-memory(実 SQLite)authority を返す。
const getUserCycleAuthorityMock =
  vi.fn<(env: DiscordEnv, userId: string) => Promise<CycleDataAuthority>>();
vi.mock("../src/goal-management/routing", () => ({
  PRIMARY_CYCLE_KEY: "primary",
  getUserCycleAuthority: (env: DiscordEnv, userId: string) =>
    getUserCycleAuthorityMock(env, userId),
}));

// モック設定後に SUT を import する。
const { evidenceDeleteHandler } = await import("../src/goal-management/handlers/evidence-delete");

const env = {} as DiscordEnv;

/**
 * マイグレーション適用済みの実 SQLite を `CycleDataAuthority` に async ラップしたアダプタと、
 * 後始末用 `db` を返す。
 */
function setupAuthority(): { db: NodeSqliteBackend; authority: CycleDataAuthority } {
  const db = new NodeSqliteBackend();
  runMigrations(db);
  const repo = createRepository(db);
  const authority: CycleDataAuthority = {
    insertRow: async (entity, row) => repo.insert(entity, row),
    getRowById: async <E extends EntityName>(entity: E, id: string) => repo.getById(entity, id),
    listRowsBy: async <E extends EntityName>(entity: E, where: Partial<EntityRow<E>>) =>
      repo.listBy(entity, where),
    removeRow: async (entity, id) => repo.remove(entity, id),
  };
  return { db, authority };
}

/** 完全に項目を埋めた EvidenceRow を生成する。 */
function makeEvidence(overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    id: "ev-1",
    cycle_id: "cyc-1",
    user_id: "user-1",
    source_type: "manual_checkin",
    source_url: null,
    title: null,
    body: "証跡本文",
    evidence_date: "2026-01-02",
    usefulness: "medium",
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

/** `/evidence delete id:..` の command interaction(type2)payload を組み立てる。 */
function evidenceDeleteCtx(evidenceId: string, userId = "user-1"): InteractionContext {
  const raw = {
    id: "interaction-1",
    application_id: "app-1",
    type: 2,
    token: "tok-evidence",
    version: 1,
    guild_id: "guild-1",
    channel_id: "chan-1",
    member: { user: { id: userId } },
    data: {
      id: "cmd-id",
      name: EVIDENCE_COMMAND_NAME,
      type: 1,
      options: [
        {
          name: EVIDENCE_DELETE_SUBCOMMAND,
          type: 1,
          options: [{ name: EVIDENCE_OPT_ID, type: 3, value: evidenceId }],
        },
      ],
    },
  };
  return {
    kind: "command",
    name: EVIDENCE_COMMAND_NAME,
    userId,
    channelId: "chan-1",
    isDm: false,
    interactionId: "interaction-1",
    token: "tok-evidence",
    raw: raw as unknown as InteractionContext["raw"],
  };
}

beforeEach(() => {
  getUserCycleAuthorityMock.mockReset();
});

describe("evidenceDeleteHandler: /evidence delete ハンドラ", () => {
  it("所有証跡を削除し ephemeral 削除完了応答を返す (3.1, 3.5, 4.4)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await authority.insertRow("evidence", makeEvidence({ id: "ev-1", user_id: "user-1" }));
      getUserCycleAuthorityMock.mockResolvedValue(authority);

      const result = await evidenceDeleteHandler.handle(evidenceDeleteCtx("ev-1"), env);

      expect(result.mode).toBe("reply");
      if (result.mode !== "reply") throw new Error("expected reply");
      expect(result.ephemeral).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      // 証跡が実際に消える。
      expect(await authority.getRowById("evidence", "ev-1")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("不存在 id は「見つからない」ephemeral 応答を返す (3.3, 4.4)", async () => {
    const { db, authority } = setupAuthority();
    try {
      getUserCycleAuthorityMock.mockResolvedValue(authority);

      const result = await evidenceDeleteHandler.handle(evidenceDeleteCtx("missing"), env);

      expect(result.mode).toBe("reply");
      if (result.mode !== "reply") throw new Error("expected reply");
      expect(result.ephemeral).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("非所有(別 user_id)の証跡は「見つからない」ephemeral 応答を返し削除しない (3.4, 4.4)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await authority.insertRow("evidence", makeEvidence({ id: "ev-other", user_id: "user-2" }));
      getUserCycleAuthorityMock.mockResolvedValue(authority);

      const result = await evidenceDeleteHandler.handle(evidenceDeleteCtx("ev-other"), env);

      expect(result.mode).toBe("reply");
      if (result.mode !== "reply") throw new Error("expected reply");
      expect(result.ephemeral).toBe(true);
      // 他ユーザーの証跡は削除されない(誤削除・露出しない)。
      expect(await authority.getRowById("evidence", "ev-other")).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it("不存在と非所有は同一文言の「見つからない」応答である(露出防止 / 3.3, 3.4)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await authority.insertRow("evidence", makeEvidence({ id: "ev-other", user_id: "user-2" }));
      getUserCycleAuthorityMock.mockResolvedValue(authority);

      const missing = await evidenceDeleteHandler.handle(evidenceDeleteCtx("missing"), env);
      const nonOwned = await evidenceDeleteHandler.handle(evidenceDeleteCtx("ev-other"), env);

      if (missing.mode !== "reply" || nonOwned.mode !== "reply") {
        throw new Error("expected reply");
      }
      // 不存在と非所有で同一文言(他ユーザーデータの存在を区別させない)。
      expect(nonOwned.content).toBe(missing.content);
    } finally {
      db.close();
    }
  });

  it("成功・失敗いずれの応答も ephemeral である (4.4)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await authority.insertRow("evidence", makeEvidence({ id: "ev-1", user_id: "user-1" }));
      getUserCycleAuthorityMock.mockResolvedValue(authority);

      const ok = await evidenceDeleteHandler.handle(evidenceDeleteCtx("ev-1"), env);
      const notFound = await evidenceDeleteHandler.handle(evidenceDeleteCtx("missing"), env);

      if (ok.mode !== "reply" || notFound.mode !== "reply") {
        throw new Error("expected reply");
      }
      expect(ok.ephemeral).toBe(true);
      expect(notFound.ephemeral).toBe(true);
    } finally {
      db.close();
    }
  });
});
