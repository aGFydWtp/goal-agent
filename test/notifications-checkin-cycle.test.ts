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
import { buildAlertMessage, buildCheckinMessage } from "../src/notifications/messages";
import { runWeeklyCheckinCycle } from "../src/notifications/domain/notification-operations";

// 週次チェックインサイクル オーケストレータ(task 6.3)の結合テスト (Req 1.2, 2.1, 3.*, 4.1, 7.1)。
//
// 方針: cron 発火コールバックが委譲する単一のドメイン関数 `runWeeklyCheckinCycle` を検証する。
//  - チェックイン(件数集計+配信)とアラート評価・配信の両方を1回の発火で起動する。
//  - `determineAllStatuses`(status-and-draft 判定)は週次発火あたり1回だけ呼ばれ、
//    チェックイン/アラート両用途で再利用される(設計 Invariant「判定は週次発火あたり1回」)。
//  - ロジックは既存の `runWeeklyCheckin` / `evaluateAndSendAlerts` へ委譲し再実装しない(Req 7.1)。

function makeEnv(): DiscordEnv {
  return {
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_APPLICATION_ID: "app-1",
    DISCORD_PUBLIC_KEY: "pub",
  } as unknown as DiscordEnv;
}

function makeDeps(nowIso = "2026-06-15T00:00:00.000Z"): DomainDeps {
  return {
    newId: () => "id-fixed",
    now: () => nowIso,
  };
}

const authority = {} as CycleDataAuthority;
const llm = {} as LlmClient;

function verdict(status: GoalStatus): StatusVerdict {
  return {
    status,
    reason: "r",
    risks: [],
    nextActions: [],
    reasonMissing: false,
  };
}

function goal(id: string, title = `goal-${id}`): EntityRow<"goals"> {
  return { id, title } as unknown as EntityRow<"goals">;
}

const cycle = {
  id: "cycle-1",
  end_date: "2026-12-31",
} as unknown as EntityRow<"evaluation_cycles">;

const okStatuses = (
  results: ReadonlyArray<{ goal: EntityRow<"goals">; verdict: StatusVerdict }>,
): DetermineAllStatusesResult => ({ ok: true, cycle, results });

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
  return { store, upsertLastStatus, recordSent };
}

const noEvidenceReader: EvidenceReader = {
  listBy: () => [],
  getById: () => null,
};

describe("runWeeklyCheckinCycle: チェックイン+アラート評価を1回の発火で起動する (Req 1.2, 2.1, 4.1)", () => {
  it("Green→Yellow 遷移でチェックイン文とアラート文を本人経路へ配信する", async () => {
    const determineAllStatuses = vi.fn(
      async (): Promise<DetermineAllStatusesResult> =>
        okStatuses([{ goal: goal("a", "目標A"), verdict: verdict("yellow") }]),
    );
    const { store, upsertLastStatus, recordSent } = makeStore({ a: "green" });
    const deliver = vi.fn(async (): Promise<SendResult> => ({ ok: true }));

    await runWeeklyCheckinCycle({
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

    // 判定は週次発火あたり1回だけ・両用途で再利用される(設計 Invariant / Req 7.1)。
    expect(determineAllStatuses).toHaveBeenCalledTimes(1);
    expect(determineAllStatuses).toHaveBeenCalledWith(authority, expect.anything(), llm, "user-1");

    // チェックイン文(件数 yellow=1)+ Yellow アラート文の2件が配信される。
    expect(deliver).toHaveBeenCalledTimes(2);
    const contents = deliver.mock.calls.map((c) => (c as [DiscordEnv, string, string])[2]);
    const userIds = deliver.mock.calls.map((c) => (c as [DiscordEnv, string, string])[1]);
    expect(userIds.every((u) => u === "user-1")).toBe(true);
    expect(contents).toContain(buildCheckinMessage({ green: 0, yellow: 1, red: 0 }));
    expect(contents).toContain(
      buildAlertMessage({
        goalId: "a",
        goalTitle: "目標A",
        newStatus: "yellow",
        reasons: ["状態悪化: green → yellow に遷移しました。"],
      }),
    );

    // アラート評価が直近状態更新・送信記録を行う(委譲先 evaluateAndSendAlerts の作用)。
    expect(upsertLastStatus).toHaveBeenCalledWith("user-1", "cycle-1", "a", "yellow");
    expect(recordSent).toHaveBeenCalledWith("user-1", "cycle-1", "a", "green_to_yellow");
  });

  it("悪化遷移なしでもチェックイン文は配信される(アラートは無し)", async () => {
    const determineAllStatuses = vi.fn(
      async (): Promise<DetermineAllStatusesResult> =>
        okStatuses([{ goal: goal("a"), verdict: verdict("green") }]),
    );
    const { store, recordSent } = makeStore({ a: "green" });
    const deliver = vi.fn(async (): Promise<SendResult> => ({ ok: true }));

    await runWeeklyCheckinCycle({
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

    expect(determineAllStatuses).toHaveBeenCalledTimes(1);
    // チェックイン文のみ(green=1)。アラートは成立せず recordSent は呼ばれない。
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((deliver.mock.calls[0] as [DiscordEnv, string, string])[2]).toBe(
      buildCheckinMessage({ green: 1, yellow: 0, red: 0 }),
    );
    expect(recordSent).not.toHaveBeenCalled();
  });
});

describe("runWeeklyCheckinCycle: アクティブサイクル不在は何もしない (Req 1.5, 4.1)", () => {
  it("no_cycle のとき配信も状態更新も走らない", async () => {
    const determineAllStatuses = vi.fn(
      async (): Promise<DetermineAllStatusesResult> => ({ ok: false, reason: "no_cycle" }),
    );
    const { store, upsertLastStatus, recordSent } = makeStore();
    const deliver = vi.fn(async (): Promise<SendResult> => ({ ok: true }));

    await runWeeklyCheckinCycle({
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

    expect(determineAllStatuses).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(upsertLastStatus).not.toHaveBeenCalled();
    expect(recordSent).not.toHaveBeenCalled();
  });

  it("no_goals では全件数0のチェックイン文のみ配信しアラートは評価しない (Req 2.4)", async () => {
    const determineAllStatuses = vi.fn(
      async (): Promise<DetermineAllStatusesResult> => ({ ok: false, reason: "no_goals" }),
    );
    const { store, recordSent } = makeStore();
    const deliver = vi.fn(async (): Promise<SendResult> => ({ ok: true }));

    await runWeeklyCheckinCycle({
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

    expect(deliver).toHaveBeenCalledTimes(1);
    expect((deliver.mock.calls[0] as [DiscordEnv, string, string])[2]).toBe(
      buildCheckinMessage({ green: 0, yellow: 0, red: 0 }),
    );
    expect(recordSent).not.toHaveBeenCalled();
  });
});
