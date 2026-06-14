import { describe, expect, it } from "vitest";
import { buildAlertMessage, buildCheckinMessage } from "../src/notifications/messages";

// Message Builder のユニットテスト(task 3.1, Req 2.2/2.4/5.1/5.2)。
// design "Message Builder" Service Interface(buildCheckinMessage / buildAlertMessage)を契約とする。
// 完了条件: §9.1 チェックイン文が件数(0件含む)を満たし、§9.3 アラート文が
//          理由行 + `/goal status <goalId>` 導線を含むことを exact substring で検証する。

describe("buildCheckinMessage (§9.1 チェックイン文)", () => {
  it("Green/Yellow/Red の3件数を個別に埋め込み、入力促し文を含む(Req 2.2)", () => {
    const message = buildCheckinMessage({ green: 2, yellow: 1, red: 0 });

    // 今週やったことの入力促し(§9.1 の主目的)。
    expect(message).toContain("今週やったこと");
    // 3 件数がそれぞれ findable であること。
    expect(message).toContain("Green: 2");
    expect(message).toContain("Yellow: 1");
    expect(message).toContain("Red: 0");
  });

  it("目標0件でも全0件として3件数を全て表示する(Req 2.4)", () => {
    const message = buildCheckinMessage({ green: 0, yellow: 0, red: 0 });

    expect(message).toContain("今週やったこと");
    // 0 の件数行を省略しないこと(Req 2.4)。
    expect(message).toContain("Green: 0");
    expect(message).toContain("Yellow: 0");
    expect(message).toContain("Red: 0");
  });
});

describe("buildAlertMessage (§9.3 アラート文)", () => {
  it("目標名・新状態・全理由行・/goal status 導線を含む(Req 5.1, 5.2)", () => {
    const message = buildAlertMessage({
      goalId: "abc-123",
      goalTitle: "API レイテンシを 200ms 以下にする",
      newStatus: "red",
      reasons: ["状態が Yellow から Red に悪化", "2週間以上 証跡なしが継続"],
    });

    // 目標名(Req 5.1)。
    expect(message).toContain("API レイテンシを 200ms 以下にする");
    // 新状態の人間向けレンダリング(Req 5.1)。status-and-draft と同じ capitalized 英語。
    expect(message).toContain("Red");
    // 各理由行(Req 5.1)。
    expect(message).toContain("状態が Yellow から Red に悪化");
    expect(message).toContain("2週間以上 証跡なしが継続");
    // 改善導線(Req 5.2): goalId を実値で補間した正確な substring。
    expect(message).toContain("/goal status abc-123");
  });

  it("理由が空でも有効なメッセージ(目標名・状態・導線)を返す", () => {
    const message = buildAlertMessage({
      goalId: "g-9",
      goalTitle: "テスト目標",
      newStatus: "yellow",
      reasons: [],
    });

    expect(message).toContain("テスト目標");
    expect(message).toContain("Yellow");
    expect(message).toContain("/goal status g-9");
  });
});
