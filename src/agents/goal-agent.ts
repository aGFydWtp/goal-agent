import { Agent, callable, getAgentByName } from "agents";
import type { Env } from "../env";
import type { EntityName, EntityRow } from "../types";
import { cycleAgentName, parseAgentName } from "./ids";

/**
 * 目標単位ロジックの論理 Agent (Req 3.1, 3.5 / design.md
 * 「EvaluationCycleAgent / GoalAgent」)。
 *
 * 責務境界(Req 3.5 / design.md "Responsibilities"):
 * - **本 Agent が所有する境界**: 目標単位の定義保持・判定・生成といった「目標単位
 *   ロジック」の責務境界。これらドメイン処理本体は下位スペックが本 Agent 上に
 *   追加する(本 infra-foundation スペックでは未実装スタブを残さない)。
 * - **データは親へ委譲**: GoalAgent は**ステートレス**であり、自前の SQLite
 *   スキーマやマイグレーションを持たない。目標 ID をコンテキストとして保持し、
 *   すべてのデータ read/write を親 EvaluationCycleAgent(サイクル単位の唯一の
 *   データ権威)へ RPC 委譲する(design.md "State Management":
 *   「Goal Agent = ステートレス(目標 ID をコンテキストとして親へ委譲)」)。
 *
 * 本 Agent 自身のインスタンス名は §6 規約の goal 名
 * (`evaluation:{userId}:{cycleId}:goal:{goalId}`)であり、そこから
 * (userId, cycleId, goalId)を導出して親サイクル Agent を特定する。
 */
export class GoalAgent extends Agent<Env> {
  /**
   * 自身のインスタンス名(§6 の goal 名)を分解し、所属コンテキスト
   * (userId, cycleId, goalId)を返す。goal 名でなければ明示的に失敗する。
   */
  private goalContext(): { userId: string; cycleId: string; goalId: string } {
    const parsed = parseAgentName(this.name);
    if (parsed === null || parsed.kind !== "goal") {
      throw new Error(`GoalAgent instance name is not a valid goal agent name: ${this.name}`);
    }
    return { userId: parsed.userId, cycleId: parsed.cycleId, goalId: parsed.goalId };
  }

  /**
   * このゴールが属するサイクルのデータ権威 EvaluationCycleAgent スタブを取得する。
   * §6 規約の cycle 名で名前解決し、親の `@callable` データ権威メソッドへ
   * RPC 委譲する入口とする。
   */
  private async parentCycleStub() {
    const { userId, cycleId } = this.goalContext();
    return await getAgentByName(this.env.EvaluationCycleAgent, cycleAgentName(userId, cycleId));
  }

  // ---- データ委譲サーフェス --------------------------------------------
  // GoalAgent は自前ストレージを持たず、以下のメソッドは親 EvaluationCycleAgent
  // のデータ権威メソッドへ透過的に委譲する(await する実 RPC; スタブではない)。
  // ドメイン判定/生成ロジックはここには持たない(責務境界の下位に属する)。

  /** 行挿入を親サイクルのデータ権威へ委譲する。 */
  @callable()
  async insertRow<E extends EntityName>(entity: E, row: EntityRow<E>): Promise<void> {
    await (await this.parentCycleStub()).insertRow(entity, row);
  }

  /** id 取得を親サイクルのデータ権威へ委譲する(無ければ null)。 */
  @callable()
  async getRowById<E extends EntityName>(entity: E, id: string): Promise<EntityRow<E> | null> {
    // 親の同名メソッドは `EntityRow<E> | null` を返すが、RPC スタブ越しでは汎用 `E`
    // が全行型の union に展開され型推論が落ちる。親シグネチャが正しさを保証するため
    // 宣言した戻り型へ復元する。
    return (await (await this.parentCycleStub()).getRowById(entity, id)) as EntityRow<E> | null;
  }

  /** 等価条件一覧を親サイクルのデータ権威へ委譲する。 */
  @callable()
  async listRowsBy<E extends EntityName>(
    entity: E,
    where: Partial<EntityRow<E>>,
  ): Promise<EntityRow<E>[]> {
    // getRowById と同様、RPC スタブ越しの汎用 `E` 復元のため宣言戻り型へ戻す。
    return (await (await this.parentCycleStub()).listRowsBy(entity, where)) as EntityRow<E>[];
  }

  /** 部分更新を親サイクルのデータ権威へ委譲する。 */
  @callable()
  async updateRow<E extends EntityName>(
    entity: E,
    id: string,
    patch: Partial<EntityRow<E>>,
  ): Promise<void> {
    await (await this.parentCycleStub()).updateRow(entity, id, patch);
  }

  /** 行削除を親サイクルのデータ権威へ委譲する。 */
  @callable()
  async removeRow<E extends EntityName>(entity: E, id: string): Promise<void> {
    await (await this.parentCycleStub()).removeRow(entity, id);
  }
}
