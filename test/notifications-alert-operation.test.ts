import { describe, expect, it, vi } from "vitest";

import type { CycleDataAuthority, DomainDeps } from "../src/goal-management/domain/cycle-operations";
import type { DiscordEnv } from "../src/discord/env";
import type { LlmClient } from "../src/llm/client";
import type { SendResult } from "../src/discord/types";
import type { DetermineAllStatusesResult } from "../src/status-and-draft/domain/status-operations";
import type { EntityRow, GoalStatus } from "../src/types";
import type { StatusVerdict } from "../src/status-and-draft/status/schema";
import type { AlertStateStore, AlertTriggerKind } from "../src/notifications/state/alert-state";
import type { EvidenceReader } from "../src/notifications/domain/notification-operations";
import { buildAlertMessage } from "../src/notifications/messages";
import { evaluateAndSendAlerts } from "../src/notifications/domain/notification-operations";

// アラート評価・配信ドメインメソッド(task 6.2)の結合テスト
// (Req 3.1-3.5, 4.1-4.8, 5.1-5.4, 6.4, 7.1, 7.2)。
//
// 方針(設計 §Notification Domain Operations `evaluateAndSendAlerts`):
//  - ドメインは純関数。上流契約(status-and-draft 判定結果の再利用 / alert-state ストア /
//    infra Repository 経由の evidence 読取 / delivery 配信)は引数注入で fake する。
//  - トリガ評価(2.2)・dedup(2.3)・メッセージ整形(3.1)・配信(4.1)は既存モジュールを
//    消費し、本タスクは合成のみを行う(再実装しない、Req 7.1/7.2)。
//  - 証跡経過は infra Repository から最新 evidence_date を読取り自前算出する(Req 4.4)。

/** テスト用 DiscordEnv(deliver fake へ素通しするのみ)。 */
function makeEnv(): DiscordEnv {
  return {
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_APPLICATION_ID: "app-1",
    DISCORD_PUBLIC_KEY: "pub",
  } as unknown as DiscordEnv;
}

/** 固定 now の DomainDeps。now() は 2026-06-15。 */
function makeDeps(nowIso = "2026-06-15T00:00:00.000Z"): DomainDeps {
  return {
    newId: () => "id-fixed",
    now: () => nowIso,
  };
}

const authority = {} as CycleDataAuthority;
const llm = {} as LlmClient;

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
function goal(id: string, title = `goal-${id}`): EntityRow<"goals"> {
  return { id, title } as unknown as EntityRow<"goals">;
}

/** cycle 終了日は十分先(期限トリガを誤発火させない)。 */
const cycle = {
  id: "cycle-1",
  end_date: "2026-12-31",
} as unknown as EntityRow<"evaluation_cycles">;

const okStatuses = (
  results: ReadonlyArray<{ goal: EntityRow<"goals">; verdict: StatusVerdict }>,
): DetermineAllStatusesResult => ({ ok: true, cycle, results });

/**
 * インメモリ AlertStateStore fake(SQL を介さず Map で last_goal_status / alert_sent_log を再現)。
 * call 記録のため vi.fn でラップした upsert/record を公開する。
 */
function makeStore(initialLast: Record<string, GoalStatus> = {}) {
  const last = new Map<string, GoalStatus>(Object.entries(initialLast));
  const sent = new Set<string>();
  const sentKey = (g: string, k: AlertTriggerKind) => `${g}::${k}`;

  const upsertLastStatus = vi.fn(
    (_u: string, _c: string, goalId: string, status: GoalStatus): void => {
      last.set(goalId, status);
    },
  );
  const recordSent = vi.fn(
    (_u: string, _c: string, goalId: string, kind: AlertTriggerKind): void => {
      sent.add(sentKey(goalId, kind));
    },
  );

  const store: AlertStateStore = {
    getLastStatuses: (_u: string, _c: string) => new Map(last),
    upsertLastStatus,
    isAlreadySent: (_u: string, _c: string, goalId: string, kind: AlertTriggerKind) =>
      sent.has(sentKey(goalId, kind)),
    recordSent,
  };
  return { store, upsertLastStatus, recordSent, last, sent };
}

/** 証跡を一切持たない EvidenceReader fake(latestEvidenceAgeDays は常に null = 証跡0件)。 */
const noEvidenceReader: EvidenceReader = {
  listBy: () => [],
  getById: () => null,
};

describe("evaluateAndSendAlerts: Green→Yellow で Yellow アラート配信 (Req 3.2, 4.2, 5.1, 6.4)", () => {
  it("配信成功で alert 配信 + recordSent + upsertLastStatus を行う", async () => {
    const determineAllStatuses = vi.fn(
      async (): Promise<DetermineAllStatusesResult> =>
        okStatuses([{ goal: goal("a", "目標A"), verdict: verdict("yellow") }]),
    );
    const { store, upsertLastStatus, recordSent } = makeStore({ a: "green" });
    const deliver = vi.fn(async (): Promise<SendResult> => ({ ok: true }));

    await evaluateAndSendAlerts({
      env: makeEnv(),
      authority,
      deps: makeDeps(),
      llm,
      userId: "user-1",
      store,
      evidence: noEvidenceReader,
      determineAllStatuses,
      deliver,
    });

    // 判定は再利用(determineAllStatuses は1回・実行ユーザー)(Req 4.1, 7.1)。
    expect(determineAllStatuses).toHaveBeenCalledTimes(1);
    expect(determineAllStatuses).toHaveBeenCalledWith(authority, expect.anything(), llm, "user-1");

    // Yellow アラートを §9.3 形式で本人経路へ1回配信(Req 5.1-5.4)。
    expect(deliver).toHaveBeenCalledTimes(1);
    const [, userId, content] = deliver.mock.calls[0] as [DiscordEnv, string, string];
    expect(userId).toBe("user-1");
    expect(content).toBe(
      buildAlertMessage({
        goalId: "a",
        goalTitle: "目標A",
        newStatus: "yellow",
        reasons: ["状態悪化: green → yellow に遷移しました。"],
      }),
    );

    // 配信成功時のみ履歴記録(Req 6.4)。直近状態は新状態へ更新(Req 3.3)。
    expect(recordSent).toHaveBeenCalledTimes(1);
    expect(recordSent).toHaveBeenCalledWith("user-1", "cycle-1", "a", "green_to_yellow");
    expect(upsertLastStatus).toHaveBeenCalledWith("user-1", "cycle-1", "a", "yellow");
  });
});

describe("evaluateAndSendAlerts: 同週同トリガ再評価で重複送信しない (Req 4.8)", () => {
  it("送信済みトリガは dedup で除外され deliver/recordSent が走らない", async () => {
    const determineAllStatuses = vi.fn(
      async (): Promise<DetermineAllStatusesResult> =>
        okStatuses([{ goal: goal("a", "目標A"), verdict: verdict("yellow") }]),
    );
    const { store, recordSent } = makeStore({ a: "green" });
    const deliver = vi.fn(async (): Promise<SendResult> => ({ ok: true }));

    const args = {
      env: makeEnv(),
      authority,
      deps: makeDeps(),
      llm,
      userId: "user-1",
      store,
      evidence: noEvidenceReader,
      determineAllStatuses,
      deliver,
    };

    // 1回目: Green→Yellow で配信 + 記録。
    await evaluateAndSendAlerts(args);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(recordSent).toHaveBeenCalledTimes(1);

    // 2回目: 直近状態は yellow に更新済み。同じ判定結果でも遷移なし & 送信済みで再送しない。
    const determineAgain = vi.fn(
      async (): Promise<DetermineAllStatusesResult> =>
        okStatuses([{ goal: goal("a", "目標A"), verdict: verdict("yellow") }]),
    );
    await evaluateAndSendAlerts({ ...args, determineAllStatuses: determineAgain });

    // 重複送信なし(deliver/recordSent は増えない)(Req 4.8)。
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(recordSent).toHaveBeenCalledTimes(1);
  });
});

describe("evaluateAndSendAlerts: 配信失敗で履歴未記録・再送可能 (Req 6.4)", () => {
  it("deliver 失敗時は recordSent を呼ばない(直近状態は更新する)", async () => {
    const determineAllStatuses = vi.fn(
      async (): Promise<DetermineAllStatusesResult> =>
        okStatuses([{ goal: goal("a", "目標A"), verdict: verdict("yellow") }]),
    );
    const { store, upsertLastStatus, recordSent } = makeStore({ a: "green" });
    const deliver = vi.fn(
      async (): Promise<SendResult> => ({ ok: false, reason: "forbidden", status: 403 }),
    );

    await evaluateAndSendAlerts({
      env: makeEnv(),
      authority,
      deps: makeDeps(),
      llm,
      userId: "user-1",
      store,
      evidence: noEvidenceReader,
      determineAllStatuses,
      deliver,
    });

    // 配信は試みる。
    expect(deliver).toHaveBeenCalledTimes(1);
    // 失敗 → 送信済み記録しない(再送可能を維持)(Req 6.4)。
    expect(recordSent).not.toHaveBeenCalled();
    // 直近状態の更新は配信成否に依存しない(Req 3.3: 比較完了後に更新)。
    expect(upsertLastStatus).toHaveBeenCalledWith("user-1", "cycle-1", "a", "yellow");
  });
});

describe("evaluateAndSendAlerts: 証跡経過2週超で no_evidence_2w 成立 (Req 4.4)", () => {
  it("最新 evidence_date を Repository から読み算出した経過が14日以上で配信する", async () => {
    // now = 2026-06-15。最新 evidence_date = 2026-05-31(15日経過 ≥ 14)→ no_evidence_2w 成立。
    const links = [
      { id: "l1", evidence_id: "e1", goal_id: "a" } as unknown as EntityRow<"evidence_goal_links">,
      { id: "l2", evidence_id: "e2", goal_id: "a" } as unknown as EntityRow<"evidence_goal_links">,
    ];
    const evidenceRows: Record<string, EntityRow<"evidence">> = {
      e1: { id: "e1", evidence_date: "2026-05-20" } as unknown as EntityRow<"evidence">,
      e2: { id: "e2", evidence_date: "2026-05-31" } as unknown as EntityRow<"evidence">,
    };
    const listBy = vi.fn((entity: string, where: Record<string, unknown>) => {
      if (entity === "evidence_goal_links") {
        return links.filter((l) => l.goal_id === where.goal_id) as never[];
      }
      return [] as never[];
    });
    const getById = vi.fn(
      (entity: string, id: string) => (entity === "evidence" ? (evidenceRows[id] ?? null) : null),
    );
    const evidence: EvidenceReader = { listBy: listBy as never, getById: getById as never };

    const determineAllStatuses = vi.fn(
      async (): Promise<DetermineAllStatusesResult> =>
        // status は据え置き(green→green: 悪化遷移なし)。証跡経過のみでトリガさせる。
        okStatuses([{ goal: goal("a", "目標A"), verdict: verdict("green") }]),
    );
    const { store, recordSent } = makeStore({ a: "green" });
    const deliver = vi.fn(async (): Promise<SendResult> => ({ ok: true }));

    await evaluateAndSendAlerts({
      env: makeEnv(),
      authority,
      deps: makeDeps("2026-06-15T00:00:00.000Z"),
      llm,
      userId: "user-1",
      store,
      evidence,
      determineAllStatuses,
      deliver,
    });

    // Repository 読取が走る(§11.5/§11.6 を goal_id で参照)。
    expect(listBy).toHaveBeenCalledWith("evidence_goal_links", { goal_id: "a" });
    // no_evidence_2w が成立し配信・記録される。
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(recordSent).toHaveBeenCalledWith("user-1", "cycle-1", "a", "no_evidence_2w");
  });

  it("証跡0件(latestEvidenceAgeDays=null)は no_evidence_2w を成立させない", async () => {
    const determineAllStatuses = vi.fn(
      async (): Promise<DetermineAllStatusesResult> =>
        okStatuses([{ goal: goal("a", "目標A"), verdict: verdict("green") }]),
    );
    const { store, recordSent } = makeStore({ a: "green" });
    const deliver = vi.fn(async (): Promise<SendResult> => ({ ok: true }));

    await evaluateAndSendAlerts({
      env: makeEnv(),
      authority,
      deps: makeDeps(),
      llm,
      userId: "user-1",
      store,
      evidence: noEvidenceReader, // 証跡0件
      determineAllStatuses,
      deliver,
    });

    // 悪化遷移も期限も証跡経過も無し → 配信なし。
    expect(deliver).not.toHaveBeenCalled();
    expect(recordSent).not.toHaveBeenCalled();
  });
});

describe("evaluateAndSendAlerts: アクティブサイクル不在/目標0件は何もしない (Req 4.1)", () => {
  it("no_cycle のとき deliver も状態更新も走らない", async () => {
    const determineAllStatuses = vi.fn(
      async (): Promise<DetermineAllStatusesResult> => ({ ok: false, reason: "no_cycle" }),
    );
    const { store, upsertLastStatus, recordSent } = makeStore();
    const deliver = vi.fn(async (): Promise<SendResult> => ({ ok: true }));

    await evaluateAndSendAlerts({
      env: makeEnv(),
      authority,
      deps: makeDeps(),
      llm,
      userId: "user-1",
      store,
      evidence: noEvidenceReader,
      determineAllStatuses,
      deliver,
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(upsertLastStatus).not.toHaveBeenCalled();
    expect(recordSent).not.toHaveBeenCalled();
  });

  it("初回判定(直近状態未保持)は悪化遷移とみなさず状態のみ保持する (Req 3.4)", async () => {
    const determineAllStatuses = vi.fn(
      async (): Promise<DetermineAllStatusesResult> =>
        okStatuses([{ goal: goal("a", "目標A"), verdict: verdict("yellow") }]),
    );
    const { store, upsertLastStatus, recordSent } = makeStore(); // 直近状態なし
    const deliver = vi.fn(async (): Promise<SendResult> => ({ ok: true }));

    await evaluateAndSendAlerts({
      env: makeEnv(),
      authority,
      deps: makeDeps(),
      llm,
      userId: "user-1",
      store,
      evidence: noEvidenceReader,
      determineAllStatuses,
      deliver,
    });

    // 初回は悪化遷移なし → 配信なし・記録なし、状態のみ保持(Req 3.4)。
    expect(deliver).not.toHaveBeenCalled();
    expect(recordSent).not.toHaveBeenCalled();
    expect(upsertLastStatus).toHaveBeenCalledWith("user-1", "cycle-1", "a", "yellow");
  });
});
