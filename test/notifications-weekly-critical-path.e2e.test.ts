// 週次通知クリティカルパスの E2E スモークテスト(task 7.1 / Req 1.2, 2.1, 3.1, 3.2, 3.3, 4.1, 4.8, 5.1)。
//
// 目的: cron 発火コールバックが委譲する統合エントリ `runWeeklyCheckinCycle` を、複数週の発火
// シーケンス(Green→Yellow→Red の状態遷移)を跨いで通し、以下の結合挙動を一気通貫で検証する。
//   - 件数付きチェックイン通知が本人経路へ毎週配信される(Req 2.1, 5.1)。
//   - 成立分の Red/Yellow アラートが本人経路へ配信される(Req 3.2, 3.3, 5.1)。
//   - 遷移検出は「本スペック保持の直近状態(last_goal_status)」を唯一の比較元として行われ、
//     週をまたいで保持・更新される(Req 3.1, 3.2, 3.3)。
//   - 同一週/サイクル内での再発火は送信済みトリガを重複配信しない(Req 4.8)。
//
// 統合の本物性(unit の再検証ではない):
//   - Alert State Store は **実 SQLite**(`node:sqlite`)を `runNotificationMigrations` で初期化した
//     `createAlertStateStore` を用いる。直近状態の保持・更新、送信履歴の dedup を fake ではなく
//     実際の永続化セマンティクスで通す。週ごとに別 store インスタンスを生成しても同一バックエンドを
//     共有し、前週に書いた状態を次週が読む(= 跨週の状態保持を genuine に検証)。
//   - 判定(status-and-draft)と配信(delivery)は外部 I/O(LLM / Discord)を持つ上流契約のため
//     注入で制御する。判定結果で週ごとの状態遷移を駆動し、配信は捕捉して本人経路・本文を検証する。
//
// 実行環境: vitest "node" プロジェクト(DO ランタイム不要 / 実 SQLite を使うため)。
// 配線(Agent → runWeeklyCheckinCycle)の DO ランタイム疎通は notifications-agent-wiring.test.ts が担う。

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CycleDataAuthority, DomainDeps } from "../src/goal-management/domain/cycle-operations";
import type { DiscordEnv } from "../src/discord/env";
import type { LlmClient } from "../src/llm/client";
import type { SendResult } from "../src/discord/types";
import type { DetermineAllStatusesResult } from "../src/status-and-draft/domain/status-operations";
import type { EntityRow, GoalStatus } from "../src/types";
import type { StatusVerdict } from "../src/status-and-draft/status/schema";
import type { EvidenceReader } from "../src/notifications/domain/notification-operations";
import { createAlertStateStore } from "../src/notifications/state/alert-state";
import { runNotificationMigrations } from "../src/notifications/state/migrations";
import { buildAlertMessage, buildCheckinMessage } from "../src/notifications/messages";
import { runWeeklyCheckinCycle } from "../src/notifications/domain/notification-operations";
import { NodeSqliteBackend } from "./helpers/node-sqlite-adapter";

const USER = "user-e2e";
const GOAL_ID = "goal-a";
const GOAL_TITLE = "目標A";

/** テスト用 DiscordEnv(deliver 捕捉へ素通しするのみ)。 */
function makeEnv(): DiscordEnv {
  return {
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_APPLICATION_ID: "app-1",
    DISCORD_PUBLIC_KEY: "pub",
  } as unknown as DiscordEnv;
}

/** 固定 now の DomainDeps。期限トリガを誤発火させないため cycle 終了日は十分先に置く。 */
function makeDeps(nowIso: string): DomainDeps {
  return {
    newId: () => "id-fixed",
    now: () => nowIso,
  };
}

const authority = {} as CycleDataAuthority;
const llm = {} as LlmClient;

/** 期限トリガ(cycle_end_*)を誤発火させないよう終了日を十分先に置いたサイクル。 */
const cycle = {
  id: "cycle-1",
  end_date: "2026-12-31",
} as unknown as EntityRow<"evaluation_cycles">;

/** 指定 status の最小 StatusVerdict(トリガ評価は status のみ参照)。 */
function verdict(status: GoalStatus): StatusVerdict {
  return {
    status,
    reason: "r",
    risks: [],
    nextActions: [],
    reasonMissing: false,
  };
}

/** 最小の goal 行(評価には id/title のみ必要)。 */
function goal(id: string, title: string): EntityRow<"goals"> {
  return { id, title } as unknown as EntityRow<"goals">;
}

/** 単一目標の判定結果(ok=true)を返す determineAllStatuses を生成する。 */
function statusesOf(status: GoalStatus): () => Promise<DetermineAllStatusesResult> {
  return async () => ({
    ok: true,
    cycle,
    results: [{ goal: goal(GOAL_ID, GOAL_TITLE), verdict: verdict(status) }],
  });
}

/** 証跡を一切持たない EvidenceReader(no_evidence_2w を成立させず、遷移トリガに焦点を絞る)。 */
const noEvidenceReader: EvidenceReader = {
  listBy: () => [],
  getById: () => null,
};

/** deliver 捕捉(本人経路 userId と本文 content を記録する)。常に成功(ok=true)。 */
interface Delivery {
  userId: string;
  content: string;
}
function makeDeliveryCapture() {
  const deliveries: Delivery[] = [];
  const deliver = async (
    _env: DiscordEnv,
    userId: string,
    content: string,
  ): Promise<SendResult> => {
    deliveries.push({ userId, content });
    return { ok: true };
  };
  return { deliveries, deliver };
}

describe("週次通知クリティカルパス E2E: 複数週の状態遷移を跨ぐチェックイン+アラート (Req 1.2, 2.1, 3.*, 4.8, 5.1)", () => {
  let backend: NodeSqliteBackend;

  beforeEach(() => {
    // 実 SQLite に notifications 追加2表(last_goal_status / alert_sent_log)を初期化する。
    // 以降すべての週は同一バックエンドを共有し、跨週の状態保持・dedup を genuine に通す。
    backend = new NodeSqliteBackend();
    runNotificationMigrations(backend);
  });

  afterEach(() => {
    backend.close();
  });

  /**
   * 1 週分の発火を実行するヘルパ。週ごとに新しい store インスタンスを生成して同一実バックエンドへ
   * 接続する(本番でも発火ごとに createAlertStateStore される=実運用に忠実)。捕捉した配信を返す。
   */
  async function fireWeek(status: GoalStatus, nowIso: string): Promise<Delivery[]> {
    const { deliveries, deliver } = makeDeliveryCapture();
    const store = createAlertStateStore(backend, {
      newId: () => `sent-${nowIso}`,
      now: () => nowIso,
    });
    await runWeeklyCheckinCycle({
      env: makeEnv(),
      authority,
      deps: makeDeps(nowIso),
      llm,
      userId: USER,
      store,
      evidence: noEvidenceReader,
      determineAllStatuses: statusesOf(status),
      deliver,
    });
    return deliveries;
  }

  it("Green→Yellow→Red の3週シーケンスで件数付きチェックインと成立アラートが本人経路へ配信され、跨週の直近状態で遷移が検出される", async () => {
    // === Week 1: Green ベースライン(初回判定 → 悪化遷移なし・Req 3.4) ===
    const w1 = await fireWeek("green", "2026-06-01T00:00:00.000Z");

    // チェックイン文(green=1)のみ。初回は直近状態未保持のため遷移アラートは出ない(Req 3.4)。
    expect(w1).toHaveLength(1);
    expect(w1[0]?.userId).toBe(USER); // 本人経路(Req 5.1)
    expect(w1[0]?.content).toBe(buildCheckinMessage({ green: 1, yellow: 0, red: 0 }));

    // 直近状態は実 SQLite に green として保持される(Req 3.1)。
    const afterW1 = createAlertStateStore(backend, {
      newId: () => "x",
      now: () => "x",
    }).getLastStatuses(USER, "cycle-1");
    expect(afterW1.get(GOAL_ID)).toBe("green");

    // === Week 2: Green→Yellow(跨週の保持状態 green を比較元に悪化検出・Req 3.2) ===
    const w2 = await fireWeek("yellow", "2026-06-08T00:00:00.000Z");

    // チェックイン文(yellow=1)+ Yellow アラート文 の2件。順不同で内容を検証する。
    expect(w2).toHaveLength(2);
    expect(w2.every((d) => d.userId === USER)).toBe(true); // 本人経路(Req 5.1)
    const w2Contents = w2.map((d) => d.content);
    expect(w2Contents).toContain(buildCheckinMessage({ green: 0, yellow: 1, red: 0 }));
    expect(w2Contents).toContain(
      buildAlertMessage({
        goalId: GOAL_ID,
        goalTitle: GOAL_TITLE,
        newStatus: "yellow",
        reasons: ["状態悪化: green → yellow に遷移しました。"],
      }),
    );

    // 直近状態は yellow に更新される(Req 3.3)。
    const afterW2 = createAlertStateStore(backend, {
      newId: () => "x",
      now: () => "x",
    }).getLastStatuses(USER, "cycle-1");
    expect(afterW2.get(GOAL_ID)).toBe("yellow");

    // === Week 3: Yellow→Red(跨週の保持状態 yellow を比較元に悪化検出・Req 3.3) ===
    const w3 = await fireWeek("red", "2026-06-15T00:00:00.000Z");

    expect(w3).toHaveLength(2);
    expect(w3.every((d) => d.userId === USER)).toBe(true);
    const w3Contents = w3.map((d) => d.content);
    expect(w3Contents).toContain(buildCheckinMessage({ green: 0, yellow: 0, red: 1 }));
    expect(w3Contents).toContain(
      buildAlertMessage({
        goalId: GOAL_ID,
        goalTitle: GOAL_TITLE,
        newStatus: "red",
        reasons: ["状態悪化: yellow → red に遷移しました。"],
      }),
    );

    // 直近状態は red に更新される。
    const afterW3 = createAlertStateStore(backend, {
      newId: () => "x",
      now: () => "x",
    }).getLastStatuses(USER, "cycle-1");
    expect(afterW3.get(GOAL_ID)).toBe("red");
  });

  it("同一週/サイクル内での再発火は送信済みアラートを重複配信せず、チェックインのみ再配信する (Req 4.8)", async () => {
    // 前段: green→yellow で Yellow アラートを送信済みにする(実 alert_sent_log に記録される)。
    await fireWeek("green", "2026-06-01T00:00:00.000Z");
    const firstYellow = await fireWeek("yellow", "2026-06-08T00:00:00.000Z");
    expect(firstYellow).toHaveLength(2); // checkin + yellow alert

    // 同一サイクル内で yellow のまま再発火: 直近状態は yellow(遷移なし)かつ送信済み(dedup)。
    const refire = await fireWeek("yellow", "2026-06-09T00:00:00.000Z");

    // チェックイン文は毎回配信されるが、green_to_yellow アラートは重複送信されない(Req 4.8)。
    expect(refire).toHaveLength(1);
    expect(refire[0]?.content).toBe(buildCheckinMessage({ green: 0, yellow: 1, red: 0 }));
    const refireAlert = refire.find((d) => d.content.startsWith("アラート"));
    expect(refireAlert).toBeUndefined();
  });
});
