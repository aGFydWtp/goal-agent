import { Agent, type AgentContext, callable } from "agents";
import type { DiscordEnv } from "../discord/env";
import type { Env } from "../env";
import { defaultDeps } from "../goal-management/domain/cycle-operations";
import { getUserCycleAuthority } from "../goal-management/routing";
import { createLlmClient } from "../llm/factory";
import { runWeeklyCheckinCycle } from "../notifications/domain/notification-operations";
import { scheduleWeeklyCheckin } from "../notifications/schedule/weekly-checkin";
import { createAlertStateStore } from "../notifications/state/alert-state";
import { runNotificationMigrations } from "../notifications/state/migrations";
import { runMigrations } from "../persistence/migrator";
import { createRepository, type Repository } from "../persistence/repository";
import type { EntityName, EntityRow } from "../types";
import { parseAgentName } from "./ids";

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
   * 汎用の揮発的インスタンス状態(per-instance KV / Req 3.7-3.9)。
   *
   * リクエスト跨ぎ(複数 Discord interaction)で確定前の一時データを保持するための
   * 基盤プリミティブ。キー/値ともに不透明な文字列として扱い、ドメイン固有の解釈・
   * 検証・スキーマは持たない(中身の意味付けは利用側スペック所有)。
   *
   * 非永続: DO SQLite と異なり永続化されず、DO 再起動/ハイバネーション復帰で消失し
   * うる。利用側は再生成可能な一時データのみを保持する前提(Req 3.9)。同一論理 DO
   * インスタンスが生きている間は `getByName` 同名解決でリクエストを跨いで参照できる。
   */
  private readonly ephemeralState = new Map<string, string>();

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

  // ---- 週次チェックイン配線(notifications への最小委譲・task 6.3) -----------
  // 本クラスはドメイン判定/色判定/トリガ評価を一切持たず、notifications モジュールの
  // 純関数へ委譲するのみ(基盤境界 6.2/6.3 / boundary.test 準拠)。`onStart` は infra の
  // ライフサイクルフックで、週次スケジュール登録と notifications 追加マイグレーションを
  // 既存ランナーと共存する形で適用する。`fireWeeklyCheckin` は cron 発火コールバックで、
  // 週次チェックインサイクル(チェックイン+アラート評価・配信)の起動を委譲する。

  /**
   * DO 起動(初回 + ハイバネーション復帰)ごとに非同期実行される infra ライフサイクルフック。
   *
   * 1. notifications 所有の追加テーブル(`last_goal_status` / `alert_sent_log`)を独立 version の
   *    冪等マイグレーションで適用する。既存 §11 ランナーと同一台帳上で共存する(Req 7.3)。
   * 2. 週次チェックイン cron を冪等登録する(Req 1.1)。再起動で `onStart` が再実行されても
   *    `scheduleWeeklyCheckin` の冪等性により重複登録しない(Req 1.4)。
   */
  async onStart(): Promise<void> {
    runNotificationMigrations(this.ctx.storage.sql);
    await scheduleWeeklyCheckin(this);
  }

  /**
   * 週次 cron 発火コールバック(`WEEKLY_CHECKIN_CALLBACK = "fireWeeklyCheckin"`) (Req 1.2)。
   *
   * 自身の Agent 名(`evaluation:{userId}:primary`)から所有ユーザーを導出し、infra 提供物
   * (データ権威 / LLM クライアント / DO SQLite)と env を集めて、notifications の週次チェックイン
   * サイクル(チェックイン配信に続けてアラート評価・配信)へ委譲する。評価/判定/整形/配信の
   * 実体はすべて notifications モジュールが所有し、本メソッドは配線のみを行う。
   */
  async fireWeeklyCheckin(): Promise<void> {
    const parsed = parseAgentName(this.name);
    if (parsed === null) {
      // Agent 名が §6 規約に適合しない場合は所有ユーザーを特定できないため、起動を見送る。
      return;
    }

    const env = this.env as DiscordEnv;
    const authority = await getUserCycleAuthority(env, parsed.userId);

    await runWeeklyCheckinCycle({
      env,
      authority,
      deps: defaultDeps(),
      llm: createLlmClient(this.env),
      userId: parsed.userId,
      store: createAlertStateStore(this.ctx.storage.sql),
      evidence: this.repository(),
    });
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

  // ---- 揮発的インスタンス状態サーフェス(汎用 KV / Req 3.7-3.9) ------------
  // ドメイン語を含まない汎用プリミティブ。上位スペックが複数 interaction を跨いで
  // 確定前の一時データを保持するための置き場。値は不透明文字列(JSON 文字列等)で
  // あり、本サーフェスは中身を解釈・検証・スキーマ化しない(利用側が意味付けする)。

  /** key に不透明文字列 value を揮発保持する(既存キーは上書き)。 */
  @callable()
  putEphemeral(key: string, value: string): void {
    this.ephemeralState.set(key, value);
  }

  /** key の揮発値を返す(無ければ null)。 */
  @callable()
  getEphemeral(key: string): string | null {
    const value = this.ephemeralState.get(key);
    return value === undefined ? null : value;
  }

  /** key の揮発値を削除する(無キーは no-op)。 */
  @callable()
  deleteEphemeral(key: string): void {
    this.ephemeralState.delete(key);
  }
}
