import { getCycleAgent, PRIMARY_CYCLE_KEY } from "../agents/routing";
import type { DiscordEnv } from "./env";
import { createFollowup } from "./followup";
import type {
  Continuation,
  DeferredContinuationEnvelope,
  Followup,
  MessageOptions,
  SendResult,
} from "./types";

/**
 * 永続的継続 substrate (Req 8.1, 8.3-8.8)。
 *
 * design.md §dispatch / registry「Persistent Continuation Substrate」の通り、継続を初期応答
 * ライフタイム(`waitUntil` budget)から切り離して DO alarm 上で実行する仕組みを提供する。
 * 本モジュールは「実行 substrate」のみを所有し、継続の業務本体(分類・判定・生成の内容)は
 * 各機能スペックが {@link Continuation} として登録する。ゲートウェイは中身を実装しない
 * (Req 8.6, 8.8)。
 *
 * 構成:
 *  - 継続レジストリ: 継続キー → {@link Continuation} の module スコープ登録状態
 *    ({@link registerContinuation} / {@link lookupContinuation})。
 *  - enqueue ヘルパー: {@link enqueueDeferredContinuation}。primary cycle agent の seam へ
 *    envelope を渡して DO alarm 登録を依頼する。
 *  - substrate runner: {@link runScheduledContinuation}。alarm 実行時に envelope から
 *    {@link Followup} を再構築し継続を照合・実行、成功時は継続自身が本応答 follow-up を送り、
 *    失敗(未登録・例外・送信失敗)時は失敗 follow-up を送って deferred 固着を防ぐ。
 *
 * 依存方向: 本モジュールは `./env`・`./types`・`./followup` と infra `../agents/routing`
 * (`getCycleAgent` / `PRIMARY_CYCLE_KEY`)のみを参照する。goal-management / status-and-draft /
 * checkin-classification 等の下位スペックは import しない(下方向 import 禁止)。dispatch /
 * registry も import しない(上方向 import 禁止 / design 依存方向)。
 */

/**
 * 継続レジストリ(module スコープの登録状態 / Req 8.6, 8.8)。
 *
 * DO isolate 上の {@link runScheduledContinuation} が `lookupContinuation(key)` を引くため、
 * 登録は DO を export するモジュールグラフから到達可能な起動時副作用として行われる必要がある
 * (adoption 側スペックが `index.ts` 起動時に {@link registerContinuation} を呼ぶ)。
 */
const continuationRegistry = new Map<string, Continuation>();

/**
 * 継続キーに業務継続関数を登録する (Req 8.6, 8.8)。
 *
 * 各機能スペックが自分の deferred 業務本体を {@link Continuation} として登録する。ゲートウェイ
 * substrate は中身を実装せず、ここで登録された関数を {@link runScheduledContinuation} が照合・
 * 実行する。同一キーの再登録は後勝ち(adoption 側で一意キーを所有する責務)。
 *
 * @param key 継続レジストリのキー({@link DeferredContinuationEnvelope.continuationKey})。
 * @param fn 登録する業務継続関数。
 */
export function registerContinuation(key: string, fn: Continuation): void {
  continuationRegistry.set(key, fn);
}

/**
 * 継続キーから登録済み継続関数を照合する (Req 8.6)。
 *
 * @param key 継続レジストリのキー。
 * @returns 登録済みなら {@link Continuation}、未登録なら `null`。
 */
export function lookupContinuation(key: string): Continuation | null {
  return continuationRegistry.get(key) ?? null;
}

/**
 * deferred-persistent 受信時に primary cycle agent の seam へ継続を委譲する (Req 8.1, 8.2)。
 *
 * `getCycleAgent(env, userId, PRIMARY_CYCLE_KEY)` でユーザー自身のホーム Agent
 * (`evaluation:{userId}:primary`)を取得し、その deferred-continuation seam メソッド
 * ({@link DeferredContinuationScheduler.scheduleDeferredContinuation})へ envelope を渡して
 * `this.schedule(0, ...)` 登録を依頼する。所有者スコープは Agent 名の userId で構造的に閉じる
 * (継続実行はユーザー自身の Agent 上で行われ、他ユーザー文脈へ越境しない)。
 *
 * `PRIMARY_CYCLE_KEY` は infra `agents/routing.ts` 所有の共有鍵であり、リテラル `"primary"` を
 * 本層で再定義しない(design Allowed Dependencies)。ゲートウェイがこのホーム Agent を選ぶのは
 * 「ユーザーごとに決定的な単一 DO」であれば十分なためで、data-authority であること自体には
 * 依存しない(継続関数が内部で権威を再取得する)。
 *
 * @param env Discord secrets を含む実行環境。
 * @param userId 実行ユーザー ID(署名検証済み interaction 文脈から供給される)。
 * @param envelope DO alarm へ運ぶ継続封筒。
 */
export async function enqueueDeferredContinuation(
  env: DiscordEnv,
  userId: string,
  envelope: DeferredContinuationEnvelope,
): Promise<void> {
  const agent = await getCycleAgent(env, userId, PRIMARY_CYCLE_KEY);
  // task 7.4 が `EvaluationCycleAgent` に `@callable scheduleDeferredContinuation` を実装で
  // 追加する。本層は enqueue が必要とする構造のみを宣言し(interface segregation)、stub を
  // その seam へ構造的に narrowing する。これは design L183 / L226-227 に明記された wiring-root
  // の相互参照であり、7.4 の実装で閉じる(`any` を使わず構造で表現する)。
  const scheduler = agent as unknown as DeferredContinuationScheduler;
  await scheduler.scheduleDeferredContinuation(envelope);
}

/**
 * substrate runner: DO alarm 実行時に継続を照合・実行する (Req 8.3-8.5)。
 *
 * 1. envelope の `interactionToken` から {@link Followup} を再構築する(application id は
 *    env が webhook URL 構築に用いる / Req 8.3, 8.4)。
 * 2. `continuationKey` で {@link Continuation} を照合する。
 *    - 未登録: 失敗 follow-up を送って終了(Req 8.5)。
 * 3. 継続を `(env, payload, followup)` で実行する。継続自身が本応答 follow-up を送る規約
 *    (Req 8.6)。substrate は継続へ渡す {@link Followup} を計装し、送信結果を観測する。
 *    - 継続が例外を投げた: 失敗 follow-up を送って終了(Req 8.5)。
 *    - 継続が正常終了したが本応答 follow-up を 1 通も成功させなかった(送信失敗 or 未送信):
 *      失敗 follow-up を送って終了(Req 8.5)。
 *    - 本応答 follow-up が成功した: 追加の失敗通知は送らない。
 *
 * 例外を呼び出し元(alarm callback)へは伝播させず、失敗時も follow-up 送出で完結させる。
 * これにより「考え中…」表示が固着しない(Req 8.5)。
 *
 * @param env Discord secrets を含む実行環境。
 * @param envelope DO alarm から運ばれた継続封筒。
 */
export async function runScheduledContinuation(
  env: DiscordEnv,
  envelope: DeferredContinuationEnvelope,
): Promise<void> {
  const followup = createFollowup(env, envelope.interactionToken);
  const instrumented = instrumentFollowup(followup);

  const continuation = lookupContinuation(envelope.continuationKey);
  if (continuation === null) {
    console.error(
      `[continuation] 継続キー未登録: "${envelope.continuationKey}" — 失敗 follow-up を送出`,
    );
    await sendFailureFollowup(followup);
    return;
  }

  try {
    await continuation(env, envelope.payload, instrumented.followup);
  } catch (error) {
    console.error(`[continuation] 継続実行で例外: key="${envelope.continuationKey}"`, error);
    await sendFailureFollowup(followup);
    return;
  }

  // 継続が正常終了しても、本応答 follow-up が 1 通も成功していなければ固着するため失敗通知を
  // 送る(token 失効等で継続自身の送信が失敗したケースを含む / Req 8.5)。
  if (!instrumented.sentSuccessfully()) {
    console.error(
      `[continuation] 継続は完了したが本応答 follow-up を送出できず: key="${envelope.continuationKey}"`,
    );
    await sendFailureFollowup(followup);
  }
}

/** 利用者に表示する失敗通知文言(個人データを露出しない汎用メッセージ)。 */
const FAILURE_MESSAGE = "処理に失敗しました。お手数ですが、もう一度お試しください。";

/**
 * 失敗 follow-up を送出する(deferred 固着防止 / Req 8.5)。
 *
 * deferred 表示(「考え中…」)を上書きするため、まず `editOriginal` で本応答枠を失敗文言へ
 * 置換する。本応答枠の編集自体が失敗(token 失効等)した場合は追加 follow-up(`send`)へ
 * フォールバックする。いずれの送信も例外を投げず {@link SendResult} を返すため、結果値で判別する。
 */
async function sendFailureFollowup(followup: Followup): Promise<void> {
  const edited = await followup.editOriginal(FAILURE_MESSAGE);
  if (!edited.ok) {
    await followup.send(FAILURE_MESSAGE);
  }
}

/**
 * 継続へ渡す {@link Followup} を計装し、本応答 follow-up が 1 通でも成功したかを観測する。
 *
 * 継続の業務本体は `Promise<void>` を返し送信結果を表に返さないため、substrate は継続へ渡す
 * {@link Followup} の `editOriginal` / `send` をラップして {@link SendResult} を観測する。
 * これにより「継続は正常終了したが follow-up 送信が失敗/未送信」を検知し、失敗 follow-up へ
 * フォールバックできる(Req 8.5)。
 */
function instrumentFollowup(inner: Followup): {
  readonly followup: Followup;
  sentSuccessfully(): boolean;
} {
  let success = false;
  const record = (result: SendResult): SendResult => {
    if (result.ok) {
      success = true;
    }
    return result;
  };
  const followup: Followup = {
    async editOriginal(content: string, opts?: MessageOptions): Promise<SendResult> {
      return record(await inner.editOriginal(content, opts));
    },
    async send(content: string, opts?: MessageOptions): Promise<SendResult> {
      return record(await inner.send(content, opts));
    },
  };
  return {
    followup,
    sentSuccessfully: () => success,
  };
}

/**
 * infra `EvaluationCycleAgent` が task 7.4 で満たす deferred-continuation seam。
 *
 * gateway は enqueue が必要とする構造のみを宣言し(interface segregation)、7.4 が実装
 * (`@callable scheduleDeferredContinuation`)で満たす。`enqueueDeferredContinuation` 内の
 * 構造的 narrowing はこの seam への wiring-root 参照(design L183, L226-227)。
 */
interface DeferredContinuationScheduler {
  scheduleDeferredContinuation(envelope: DeferredContinuationEnvelope): Promise<void>;
}
