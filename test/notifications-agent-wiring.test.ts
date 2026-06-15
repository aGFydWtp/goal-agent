import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { WEEKLY_CHECKIN_CALLBACK, WEEKLY_CHECKIN_CRON } from "../src/notifications/schedule/weekly-checkin";

// EvaluationCycleAgent への週次チェックイン配線(task 6.3)の結合テスト (Req 1.1, 1.2, 7.3)。
//
// 実行プロジェクト: "workers"(Cloudflare Workers ランタイム + DO SQLite)。
// 検証内容(完了条件):
//  1. Agent 初期化(onStart)後、週次スケジュールが1件登録され、notifications 追加テーブル
//     (last_goal_status / alert_sent_log)が DO SQLite に初期化済みになる。
//  2. 再初期化(同一論理インスタンスへの再アクセス + onStart 再実行)で重複登録しない(冪等)。
//  3. cron 発火(fireWeeklyCheckin 呼び出し)が notifications ドメインへ委譲して起動する
//     (アクティブサイクル不在では何も配信せず・例外なく完了する = 委譲先 no_cycle 経路)。
//
// 配線は最小(boundary.test 準拠): Agent はスケジュール登録 + 追加マイグレーション適用 +
// 発火コールバックの委譲のみを持ち、ドメインロジック/色判定は notifications モジュールに保つ。

/** DO の SQLite に指定テーブルが存在するかを sqlite_master で確認する。 */
function tableExists(sql: SqlStorage, table: string): boolean {
  const rows = sql
    .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table)
    .toArray();
  return rows.length > 0;
}

describe("EvaluationCycleAgent 週次チェックイン配線: 初期化(onStart)", () => {
  it("週次スケジュールが1件登録され、notifications 追加テーブルが初期化される (Req 1.1, 7.3)", async () => {
    const stub = env.EvaluationCycleAgent.getByName("evaluation:wire-u1:primary");

    // RPC を1度通して DO を起動させる。
    await stub.getRowById("evaluation_cycles", "none");

    await runInDurableObject(stub, async (instance, state) => {
      // 初期化(onStart)完了を決定的に待ってから登録結果を照会する。onStart は冪等のため
      // 既に1度走っていても重複登録しない(Req 1.4)。
      const agent = instance as unknown as {
        onStart(): Promise<void>;
        getSchedules(): ReadonlyArray<{ callback?: string; cron?: string }>;
      };
      await agent.onStart();

      const schedules = agent.getSchedules();
      const weekly = schedules.filter((s) => s.callback === WEEKLY_CHECKIN_CALLBACK);
      expect(weekly).toHaveLength(1);
      expect(weekly[0]?.cron).toBe(WEEKLY_CHECKIN_CRON);

      // notifications 追加テーブルが冪等マイグレーションで作成済み(Req 7.3: 既存ランナー共存)。
      const sql = state.storage.sql;
      expect(tableExists(sql, "last_goal_status")).toBe(true);
      expect(tableExists(sql, "alert_sent_log")).toBe(true);
      // infra §11 テーブルも共存して初期化済み。
      expect(tableExists(sql, "evaluation_cycles")).toBe(true);
    });
  });

  it("再初期化(onStart 再実行)でも週次スケジュールは1件のまま重複登録しない (Req 1.1 冪等)", async () => {
    const stub = env.EvaluationCycleAgent.getByName("evaluation:wire-u2:primary");
    await stub.getRowById("evaluation_cycles", "none");

    // onStart を明示的に再実行して冪等性を検証する。
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as {
        onStart(): Promise<void>;
        getSchedules(): ReadonlyArray<{ callback?: string }>;
      };
      await agent.onStart();
      await agent.onStart();

      const weekly = agent
        .getSchedules()
        .filter((s) => s.callback === WEEKLY_CHECKIN_CALLBACK);
      expect(weekly).toHaveLength(1);
    });
  });
});

describe("EvaluationCycleAgent 週次チェックイン配線: 発火コールバック委譲", () => {
  it("fireWeeklyCheckin はドメインへ委譲し、アクティブサイクル不在では例外なく完了する (Req 1.2)", async () => {
    const stub = env.EvaluationCycleAgent.getByName("evaluation:wire-u3:primary");
    await stub.getRowById("evaluation_cycles", "none");

    // サイクル未作成 → 委譲先 runWeeklyCheckinCycle が no_cycle で配信せず完了する。
    // 配線が正しく委譲していれば(LLM/Discord に到達せず)例外なく解決する。
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as { fireWeeklyCheckin(): Promise<void> };
      await expect(agent.fireWeeklyCheckin()).resolves.toBeUndefined();
    });
  });
});
