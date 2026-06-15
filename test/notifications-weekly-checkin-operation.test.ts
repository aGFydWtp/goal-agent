import { describe, expect, it, vi } from "vitest";

import type { CycleDataAuthority, DomainDeps } from "../src/goal-management/domain/cycle-operations";
import type { DiscordEnv } from "../src/discord/env";
import type { LlmClient } from "../src/llm/client";
import type { SendResult } from "../src/discord/types";
import type { DetermineAllStatusesResult } from "../src/status-and-draft/domain/status-operations";
import type { EntityRow } from "../src/types";
import type { StatusVerdict } from "../src/status-and-draft/status/schema";
import { buildCheckinMessage } from "../src/notifications/messages";
import { runWeeklyCheckin } from "../src/notifications/domain/notification-operations";

// 週次チェックイン実行ドメインメソッド(task 6.1)の結合テスト (Req 1.2, 1.5, 2.1, 2.4, 7.1)。
//
// 方針(設計 §Notification Domain Operations / tasks.md 確立パターン):
//  - ドメインは純関数。上流契約(status-and-draft の判定 / delivery 配信)は引数注入で fake する。
//  - 判定は status-and-draft の `determineAllStatuses` へ委譲し再実装しない(Req 7.1)。色/件数は
//    判定結果の `verdict.status` を集計するのみで、本テストは fake が返した verdict から件数が
//    正しく導かれることを検証する。
//  - 配信は delivery の `deliver` 相当へ委譲する。本テストはそれを fake してメッセージ本文と
//    呼び出し回数を検証する。
//
// 完了条件(タスク):
//  - サイクルあり → determineAllStatuses を1回呼び、Green/Yellow/Red を集計し件数付き
//    チェックイン文を配信する。
//  - 目標0件 → 全件数0のチェックイン文を配信する。
//  - サイクルなし → 何も配信しない(deliver / determineAllStatuses 後段が走らない)。

/** テスト用 DiscordEnv(deliver fake へそのまま渡るだけで中身は参照されない)。 */
function makeEnv(): DiscordEnv {
  return {
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_APPLICATION_ID: "app-1",
    DISCORD_PUBLIC_KEY: "pub",
  } as unknown as DiscordEnv;
}

/** テスト用 DomainDeps(固定時刻)。 */
function makeDeps(): DomainDeps {
  return {
    newId: () => "id-fixed",
    now: () => "2026-06-15T00:00:00.000Z",
  };
}

/** runWeeklyCheckin は authority/llm を determineAllStatuses fake へ素通しするのみ。 */
const authority = {} as CycleDataAuthority;
const llm = {} as LlmClient;

/** 指定 status の最小 StatusVerdict を作る(集計対象は status のみ)。 */
function verdict(status: StatusVerdict["status"]): StatusVerdict {
  return {
    status,
    reason: "r",
    risks: [],
    nextActions: [],
    reasonMissing: false,
  };
}

/** 最小の goal 行(集計には title/id 以外不要)。 */
function goal(id: string): EntityRow<"goals"> {
  return { id, title: `goal-${id}` } as unknown as EntityRow<"goals">;
}

/** 最小の cycle 行。 */
const cycle = { id: "cycle-1", end_date: "2026-09-30" } as unknown as EntityRow<"evaluation_cycles">;

const okResult = (
  results: ReadonlyArray<{ goal: EntityRow<"goals">; verdict: StatusVerdict }>,
): DetermineAllStatusesResult => ({ ok: true, cycle, results });

describe("runWeeklyCheckin: サイクルあり・件数集計と配信 (Req 1.2, 2.1, 2.4, 7.1)", () => {
  it("Green/Yellow/Red を集計し件数付きチェックイン文を1回配信する", async () => {
    const determineAllStatuses = vi.fn(
      async (): Promise<DetermineAllStatusesResult> =>
        okResult([
          { goal: goal("a"), verdict: verdict("green") },
          { goal: goal("b"), verdict: verdict("green") },
          { goal: goal("c"), verdict: verdict("yellow") },
          { goal: goal("d"), verdict: verdict("red") },
        ]),
    );
    const deliver = vi.fn(async (): Promise<SendResult> => ({ ok: true }));

    await runWeeklyCheckin({
      env: makeEnv(),
      authority,
      deps: makeDeps(),
      llm,
      userId: "user-1",
      determineAllStatuses,
      deliver,
    });

    // determineAllStatuses は週次発火あたり1回・実行ユーザーで呼ばれる(Req 2.1, 7.1)。
    expect(determineAllStatuses).toHaveBeenCalledTimes(1);
    expect(determineAllStatuses).toHaveBeenCalledWith(authority, expect.anything(), llm, "user-1");

    // 件数付きチェックイン文を本人経路へ1回配信する(Req 2.2, 2.3)。
    expect(deliver).toHaveBeenCalledTimes(1);
    const [, deliveredUserId, deliveredContent] = deliver.mock.calls[0] as [
      DiscordEnv,
      string,
      string,
    ];
    expect(deliveredUserId).toBe("user-1");
    expect(deliveredContent).toBe(buildCheckinMessage({ green: 2, yellow: 1, red: 1 }));
  });

  it("gray 状態は Green/Yellow/Red のいずれにも数えない", async () => {
    const determineAllStatuses = vi.fn(
      async (): Promise<DetermineAllStatusesResult> =>
        okResult([
          { goal: goal("a"), verdict: verdict("green") },
          { goal: goal("b"), verdict: verdict("gray") },
        ]),
    );
    const deliver = vi.fn(async (): Promise<SendResult> => ({ ok: true }));

    await runWeeklyCheckin({
      env: makeEnv(),
      authority,
      deps: makeDeps(),
      llm,
      userId: "user-1",
      determineAllStatuses,
      deliver,
    });

    const content = (deliver.mock.calls[0] as [DiscordEnv, string, string])[2];
    expect(content).toBe(buildCheckinMessage({ green: 1, yellow: 0, red: 0 }));
  });
});

describe("runWeeklyCheckin: 目標0件は全0件 (Req 2.4)", () => {
  it("no_goals でも全件数0のチェックイン文を配信する", async () => {
    const determineAllStatuses = vi.fn(
      async (): Promise<DetermineAllStatusesResult> => ({ ok: false, reason: "no_goals" }),
    );
    const deliver = vi.fn(async (): Promise<SendResult> => ({ ok: true }));

    await runWeeklyCheckin({
      env: makeEnv(),
      authority,
      deps: makeDeps(),
      llm,
      userId: "user-1",
      determineAllStatuses,
      deliver,
    });

    expect(deliver).toHaveBeenCalledTimes(1);
    const content = (deliver.mock.calls[0] as [DiscordEnv, string, string])[2];
    expect(content).toBe(buildCheckinMessage({ green: 0, yellow: 0, red: 0 }));
  });

  it("ok:true だが results が空でも全件数0で配信する", async () => {
    const determineAllStatuses = vi.fn(
      async (): Promise<DetermineAllStatusesResult> => okResult([]),
    );
    const deliver = vi.fn(async (): Promise<SendResult> => ({ ok: true }));

    await runWeeklyCheckin({
      env: makeEnv(),
      authority,
      deps: makeDeps(),
      llm,
      userId: "user-1",
      determineAllStatuses,
      deliver,
    });

    const content = (deliver.mock.calls[0] as [DiscordEnv, string, string])[2];
    expect(content).toBe(buildCheckinMessage({ green: 0, yellow: 0, red: 0 }));
  });
});

describe("runWeeklyCheckin: サイクルなしは何も配信しない (Req 1.5)", () => {
  it("no_cycle のとき deliver を呼ばずに終了する", async () => {
    const determineAllStatuses = vi.fn(
      async (): Promise<DetermineAllStatusesResult> => ({ ok: false, reason: "no_cycle" }),
    );
    const deliver = vi.fn(async (): Promise<SendResult> => ({ ok: true }));

    await runWeeklyCheckin({
      env: makeEnv(),
      authority,
      deps: makeDeps(),
      llm,
      userId: "user-1",
      determineAllStatuses,
      deliver,
    });

    // アクティブサイクル無し → 何も配信しない(Req 1.5)。
    expect(deliver).not.toHaveBeenCalled();
  });
});
