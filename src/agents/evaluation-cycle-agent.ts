import { Agent, type AgentContext, callable } from "agents";
import type { Env } from "../env";
import { runMigrations } from "../persistence/migrator";
import { createRepository, type Repository } from "../persistence/repository";
import type { EntityName, EntityRow } from "../types";

/**
 * サイクル単位のデータ権威となる Agent (Req 3.1, 3.5 / design.md
 * 「EvaluationCycleAgent / GoalAgent」)。
 *
 * 責務境界(§6 / Req 3.5):
 * - **サイクル全体の管理**: §11 全テーブルを保持するサイクル単位 DO SQLite を
 *   唯一の権威データストアとして管理する。
 * - **分類委譲**: チェックイン分類などのドメイン処理は下位スペックが実装するが、
 *   その読み書きは本 Agent が保持するリポジトリ(データ権威)へ委譲される。
 * - **全体集約**: 週次レビュー・ドラフト生成などサイクル横断の集約も、本 Agent の
 *   リポジトリを単一の真実源として行う。
 *
 * 本スペック(infra-foundation)は未実装スタブを残さず、基盤として完結する部分
 * ——起動時のスキーマ初期化と、上位機能/GoalAgent が委譲する型付きデータ権威
 * 配線——のみを実装する。ドメインロジック本体(目標管理・分類・生成等)は
 * 下位スペックが本 Agent 上に追加する。
 */
export class EvaluationCycleAgent extends Agent<Env> {
  /** サイクル単位 DO SQLite に束ねた型付きリポジトリ(データ権威)。 */
  private readonly repositoryInstance: Repository;

  /**
   * DO インスタンス生成(初回起動およびハイバネーション復帰)時に同期実行される。
   * §11 スキーマを冪等マイグレーションで初期化してから、データ権威リポジトリを束ねる
   * (design.md「スキーマ初期化フロー」/ Req 2.2 のトリガ, Req 3.1)。
   *
   * コンストラクタは Durable Object のすべての fetch / RPC ハンドラより先に
   * 完了が保証されるため、`@callable` データ権威メソッドが実行される時点で
   * スキーマは必ず初期化済みになる(`onStart` は非同期で RPC をゲートしない)。
   *
   * 各マイグレーション version は再実行安全であり、台帳により全体が冪等のため、
   * 起動のたびに呼んでも既存データを破壊しない。
   */
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    runMigrations(this.ctx.storage.sql);
    this.repositoryInstance = createRepository(this.ctx.storage.sql);
  }

  /** このサイクルの権威 SQLite に束ねたリポジトリを返す。 */
  private repository(): Repository {
    return this.repositoryInstance;
  }

  // ---- データ権威サーフェス(委譲配線) ---------------------------------
  // GoalAgent(task 4.3)および上位ハンドラが、自前のストレージを持たずに
  // このサイクルの SQLite へ型付きで read/write するための委譲入口。
  // ドメイン判定は持たず、リポジトリへ透過的に委譲する。

  /** 行を挿入する(データ権威への委譲入口)。 */
  @callable()
  insertRow<E extends EntityName>(entity: E, row: EntityRow<E>): void {
    this.repository().insert(entity, row);
  }

  /** id で 1 行取得する(無ければ null)。 */
  @callable()
  getRowById<E extends EntityName>(entity: E, id: string): EntityRow<E> | null {
    return this.repository().getById(entity, id);
  }

  /** 等価条件(AND)で行を一覧する。 */
  @callable()
  listRowsBy<E extends EntityName>(entity: E, where: Partial<EntityRow<E>>): EntityRow<E>[] {
    return this.repository().listBy(entity, where);
  }

  /** id 指定で部分更新する(空 patch は no-op)。 */
  @callable()
  updateRow<E extends EntityName>(entity: E, id: string, patch: Partial<EntityRow<E>>): void {
    this.repository().update(entity, id, patch);
  }

  /** id 指定で削除する。 */
  @callable()
  removeRow<E extends EntityName>(entity: E, id: string): void {
    this.repository().remove(entity, id);
  }
}
