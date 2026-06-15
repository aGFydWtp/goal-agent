// 証跡削除と所有者スコープの境界統合テスト(goal-management task 5.2 / Req 3.1, 3.2, 3.4, 3.5, 4.1, 4.2, 4.4)。
//
// このテストは個別ハンドラ単体ではなく、(a) `/evidence delete` ハンドラ経由の証跡削除が
// 紐づく evidence_goal_links ごと単一権威から消えること、(b) 不存在/非所有が同一文言の
// ephemeral 応答へ正規化され他ユーザーデータを露出しないこと、(c) サイクル/目標/証跡の
// いずれについても他ユーザー所有データを対象とする read/write が「不存在(null / not_found)」
// として扱われ越境アクセスが拒否されること、を end-to-end の境界観点で検証する。
//
// 方針: DO を起動せず、`getUserCycleAuthority` を「同一の」実 SQLite 権威
// (`createRepository(NodeSqliteBackend)` を async ラップしたアダプタ)へ差し替える。
// 複数ユーザーのデータを同一権威に同居させ、所有者スコープ(user_id 強制)が層を貫いて
// 越境を不存在化することを、権威直読みでアサートする。実行環境: vitest projects の "node"。
//
// 既存テストとの差: handler 単体(evidence-delete-handler)/ドメイン単体(delete-evidence)が
// 各層を分離して検証するのに対し、本テストは「ハンドラ → ドメイン → 単一権威」を貫いた削除の
// リンク連動と、サイクル/目標/証跡を横断した越境拒否を 1 つの権威上で統合検証する。

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscordEnv } from "../src/discord/env";
import type { InteractionContext } from "../src/discord/types";
import {
  EVIDENCE_COMMAND_NAME,
  EVIDENCE_DELETE_SUBCOMMAND,
  EVIDENCE_OPT_ID,
} from "../src/goal-management/commands";
import {
  type CycleDataAuthority,
  deleteEvidence,
  getGoal,
  listGoals,
} from "../src/goal-management/domain/cycle-operations";
import { runMigrations } from "../src/persistence/migrator";
import { createRepository } from "../src/persistence/repository";
import type {
  EntityName,
  EntityRow,
  EvaluationCycleRow,
  EvidenceGoalLinkRow,
  EvidenceRow,
  GoalRow,
} from "../src/types";
import { NodeSqliteBackend } from "./helpers/node-sqlite-adapter";

// routing をモックして DO 起動を避け、同一の in-memory(実 SQLite)権威を返す。
const getUserCycleAuthorityMock =
  vi.fn<(env: DiscordEnv, userId: string) => Promise<CycleDataAuthority>>();
vi.mock("../src/goal-management/routing", () => ({
  PRIMARY_CYCLE_KEY: "primary",
  getUserCycleAuthority: (env: DiscordEnv, userId: string) =>
    getUserCycleAuthorityMock(env, userId),
}));

// モック設定後に SUT(ハンドラ)を import する。
const { evidenceDeleteHandler } = await import("../src/goal-management/handlers/evidence-delete");

const env = {} as DiscordEnv;

/** マイグレーション適用済みの実 SQLite を CycleDataAuthority に async ラップして返す。 */
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

/** 完全に項目を埋めた EvaluationCycleRow を生成する。 */
function makeCycle(overrides: Partial<EvaluationCycleRow> = {}): EvaluationCycleRow {
  return {
    id: "cyc-1",
    user_id: "user-1",
    name: "2026 上期",
    start_date: "2026-01-01",
    end_date: "2026-06-30",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** 完全に項目を埋めた GoalRow を生成する。 */
function makeGoal(overrides: Partial<GoalRow> = {}): GoalRow {
  return {
    id: "goal-1",
    cycle_id: "cyc-1",
    user_id: "user-1",
    title: "目標 A",
    description: "目標本文",
    success_criteria: null,
    evaluation_points: null,
    status: "gray",
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
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

/** EvidenceGoalLinkRow を生成する。 */
function makeLink(overrides: Partial<EvidenceGoalLinkRow> = {}): EvidenceGoalLinkRow {
  return {
    id: "link-1",
    evidence_id: "ev-1",
    goal_id: "goal-1",
    relevance_score: 0.5,
    reason: null,
    created_at: "2026-01-02T00:00:00.000Z",
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

describe("証跡削除と所有者スコープの境界統合(単一権威での横断検証)", () => {
  it("/evidence delete: 所有証跡が紐づく evidence_goal_links ごと削除され、削除完了 ephemeral 応答が返る (3.1, 3.2, 3.5, 4.4)", async () => {
    const { db, authority } = setupAuthority();
    try {
      getUserCycleAuthorityMock.mockResolvedValue(authority);

      // 実行ユーザー(user-1)所有の証跡と、それに紐づく複数リンク。
      await authority.insertRow("evidence", makeEvidence({ id: "ev-1", user_id: "user-1" }));
      await authority.insertRow(
        "evidence_goal_links",
        makeLink({ id: "link-1", evidence_id: "ev-1", goal_id: "goal-1" }),
      );
      await authority.insertRow(
        "evidence_goal_links",
        makeLink({ id: "link-2", evidence_id: "ev-1", goal_id: "goal-2" }),
      );
      // 別証跡(同ユーザー)とそのリンク = 連動削除の対象外であることを確認する対照。
      await authority.insertRow("evidence", makeEvidence({ id: "ev-keep", user_id: "user-1" }));
      await authority.insertRow(
        "evidence_goal_links",
        makeLink({ id: "link-keep", evidence_id: "ev-keep", goal_id: "goal-1" }),
      );

      const result = await evidenceDeleteHandler.handle(evidenceDeleteCtx("ev-1"), env);

      // 削除完了応答は本人にのみ可視(ephemeral)で返る(3.5, 4.4)。
      if (result.mode !== "reply") throw new Error("expected reply");
      expect(result.ephemeral).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);

      // 証跡本体が単一権威から削除される(3.1)。
      expect(await authority.getRowById("evidence", "ev-1")).toBeNull();
      // 当該 evidence_id のリンクが連動削除され孤立参照を残さない(3.2)。
      expect(
        await authority.listRowsBy("evidence_goal_links", { evidence_id: "ev-1" }),
      ).toHaveLength(0);
      // ルーティングが実行ユーザーのデータホーム解決に用いられた。
      expect(getUserCycleAuthorityMock).toHaveBeenCalledWith(env, "user-1");

      // 別証跡とそのリンクは連動削除の対象外として残る(対象限定であること)。
      expect(await authority.getRowById("evidence", "ev-keep")).not.toBeNull();
      expect(
        await authority.listRowsBy("evidence_goal_links", { evidence_id: "ev-keep" }),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("/evidence delete: 不存在 id と非所有証跡はいずれも同一文言の「見つからない」ephemeral 応答で、他ユーザー証跡を削除も露出もしない (3.4, 4.2, 4.4)", async () => {
    const { db, authority } = setupAuthority();
    try {
      getUserCycleAuthorityMock.mockResolvedValue(authority);

      // 他ユーザー(user-2)所有の証跡 + 紐づくリンク。実行ユーザーは user-1。
      await authority.insertRow("evidence", makeEvidence({ id: "ev-other", user_id: "user-2" }));
      await authority.insertRow(
        "evidence_goal_links",
        makeLink({ id: "link-other", evidence_id: "ev-other", goal_id: "goal-1" }),
      );

      const missing = await evidenceDeleteHandler.handle(evidenceDeleteCtx("missing"), env);
      const nonOwned = await evidenceDeleteHandler.handle(evidenceDeleteCtx("ev-other"), env);

      if (missing.mode !== "reply" || nonOwned.mode !== "reply") {
        throw new Error("expected reply");
      }
      // 両者とも ephemeral(4.4)。
      expect(missing.ephemeral).toBe(true);
      expect(nonOwned.ephemeral).toBe(true);
      // 不存在と非所有が同一文言 = 他ユーザーデータの存在を露出しない(3.4, 4.2)。
      expect(nonOwned.content).toBe(missing.content);

      // 他ユーザーの証跡・リンクは削除されない(越境書き込みの拒否)。
      expect(await authority.getRowById("evidence", "ev-other")).not.toBeNull();
      expect(
        await authority.listRowsBy("evidence_goal_links", { evidence_id: "ev-other" }),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("所有者スコープ越境拒否: 他ユーザー所有の証跡を対象とする deleteEvidence は not_found となり削除されない (4.1, 4.2)", async () => {
    const { db, authority } = setupAuthority();
    try {
      // user-2 所有の証跡 + リンク。user-1 が越境削除を試みる。
      await authority.insertRow("evidence", makeEvidence({ id: "ev-x", user_id: "user-2" }));
      await authority.insertRow(
        "evidence_goal_links",
        makeLink({ id: "link-x", evidence_id: "ev-x", goal_id: "goal-1" }),
      );

      const crossUser = await deleteEvidence(authority, "user-1", "ev-x");
      expect(crossUser).toEqual({ ok: false, reason: "not_found" });
      // 越境は不存在化され、他ユーザーの証跡・リンクは残る。
      expect(await authority.getRowById("evidence", "ev-x")).not.toBeNull();
      expect(
        await authority.listRowsBy("evidence_goal_links", { evidence_id: "ev-x" }),
      ).toHaveLength(1);

      // 所有者本人(user-2)からは削除でき、越境拒否が所有者の正当操作を阻害しないこと。
      const owner = await deleteEvidence(authority, "user-2", "ev-x");
      expect(owner).toEqual({ ok: true });
      expect(await authority.getRowById("evidence", "ev-x")).toBeNull();
      expect(
        await authority.listRowsBy("evidence_goal_links", { evidence_id: "ev-x" }),
      ).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("所有者スコープ越境拒否: 他ユーザー所有の目標を対象とする getGoal / listGoals は不存在(null / 空)として扱われる (4.1, 4.2)", async () => {
    const { db, authority } = setupAuthority();
    try {
      // user-2 所有のサイクルと目標。user-1 が同一 id で越境取得を試みる。
      await authority.insertRow(
        "evaluation_cycles",
        makeCycle({ id: "cyc-2", user_id: "user-2" }),
      );
      await authority.insertRow(
        "goals",
        makeGoal({ id: "goal-2", cycle_id: "cyc-2", user_id: "user-2" }),
      );

      // 越境 getGoal は null(他ユーザー目標を露出しない)。
      expect(await getGoal(authority, "user-1", "cyc-2", "goal-2")).toBeNull();
      // 越境 listGoals は空配列(他ユーザーのサイクル内目標を一切返さない)。
      expect(await listGoals(authority, "user-1", "cyc-2")).toEqual([]);

      // 所有者本人(user-2)は同一 id で取得でき、越境拒否が正当取得を阻害しない。
      const owned = await getGoal(authority, "user-2", "cyc-2", "goal-2");
      expect(owned?.id).toBe("goal-2");
      expect(await listGoals(authority, "user-2", "cyc-2")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("所有者スコープ越境拒否: 複数ユーザーのデータが同居しても各操作は実行ユーザーの所有に限定される (4.1, 4.2)", async () => {
    const { db, authority } = setupAuthority();
    try {
      // user-1 と user-2 のサイクル/目標/証跡を同一権威に同居させる。
      await authority.insertRow(
        "evaluation_cycles",
        makeCycle({ id: "cyc-1", user_id: "user-1" }),
      );
      await authority.insertRow(
        "evaluation_cycles",
        makeCycle({ id: "cyc-2", user_id: "user-2" }),
      );
      await authority.insertRow(
        "goals",
        makeGoal({ id: "goal-1", cycle_id: "cyc-1", user_id: "user-1" }),
      );
      await authority.insertRow(
        "goals",
        makeGoal({ id: "goal-2", cycle_id: "cyc-2", user_id: "user-2" }),
      );
      await authority.insertRow(
        "evidence",
        makeEvidence({ id: "ev-1", cycle_id: "cyc-1", user_id: "user-1" }),
      );
      await authority.insertRow(
        "evidence",
        makeEvidence({ id: "ev-2", cycle_id: "cyc-2", user_id: "user-2" }),
      );

      // user-1 の listGoals は自分のサイクル内の自分の目標のみを返す(他ユーザーの目標を含まない)。
      const u1Goals = await listGoals(authority, "user-1", "cyc-1");
      expect(u1Goals.map((g) => g.id)).toEqual(["goal-1"]);
      // user-1 が user-2 のサイクル id を渡しても空(サイクル所有者でもスコープ越境を拒否)。
      expect(await listGoals(authority, "user-1", "cyc-2")).toEqual([]);

      // 越境 getGoal は双方向に不存在化される。
      expect(await getGoal(authority, "user-1", "cyc-2", "goal-2")).toBeNull();
      expect(await getGoal(authority, "user-2", "cyc-1", "goal-1")).toBeNull();

      // 越境 deleteEvidence は双方向に not_found で、相手の証跡を削除しない。
      expect(await deleteEvidence(authority, "user-1", "ev-2")).toEqual({
        ok: false,
        reason: "not_found",
      });
      expect(await deleteEvidence(authority, "user-2", "ev-1")).toEqual({
        ok: false,
        reason: "not_found",
      });
      expect(await authority.getRowById("evidence", "ev-1")).not.toBeNull();
      expect(await authority.getRowById("evidence", "ev-2")).not.toBeNull();

      // 各ユーザーの正当操作は引き続き成立する(スコープが正当アクセスを阻害しない)。
      expect((await getGoal(authority, "user-1", "cyc-1", "goal-1"))?.id).toBe("goal-1");
      expect((await getGoal(authority, "user-2", "cyc-2", "goal-2"))?.id).toBe("goal-2");
    } finally {
      db.close();
    }
  });
});
