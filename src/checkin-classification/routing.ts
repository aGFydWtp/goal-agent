// checkin-classification の pending 分類 routing ブリッジ(task 3.2/3.3 が消費)。
//
// 分類完了(modal submit)と確定操作(保存/修正/破棄ボタン)は別々の Discord interaction
// リクエストであり、ボタン custom_id には pendingId しか乗らない。確定対象の分類結果は
// リクエストを跨いで保持する必要があり、その唯一の正しい置き場は EvaluationCycleAgent
// インスタンスに常駐する揮発状態である(infra-foundation task 4.5 の汎用揮発 KV /
// putEphemeral/getEphemeral/deleteEphemeral)。
//
// 本モジュールは infra の汎用 KV(不透明文字列)を、domain/checkin-operations.ts の同期
// `PendingCheckinStore` と橋渡しする async ラッパに変換する。ドメインロジックは worker 側
// (domain)に留め、Agent へはドメインメソッドを追加しない(infra boundary / Req 6.2 適合)。
//
// 依存方向: handlers → routing → infra `getCycleAgent` / infra `PRIMARY_CYCLE_KEY` /
// 自スペック domain(左方向のみ)。

import { getCycleAgent, PRIMARY_CYCLE_KEY } from "../agents/routing";
import type { DiscordEnv } from "../discord/env";
import {
  createPendingCheckinStore,
  type PendingCheckinClassification,
  type PendingCheckinStore,
} from "./domain/checkin-operations";

/** ephemeral KV 上で pending 分類を保持するキーの接頭辞。pendingId を付けて一意化する。 */
const PENDING_KEY_PREFIX = "checkin:pending:";

/** pendingId から ephemeral KV キーを組み立てる。 */
export function pendingCheckinKey(pendingId: string): string {
  return `${PENDING_KEY_PREFIX}${pendingId}`;
}

/**
 * EvaluationCycleAgent の汎用揮発 KV を async インターフェイスとして公開する。
 *
 * DO スタブの `putEphemeral`/`getEphemeral`/`deleteEphemeral` は RPC で Promise 化される。
 * 値は不透明文字列(pending 分類の JSON)で、本ラッパは中身を解釈しない。
 */
export interface CheckinEphemeralKv {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

/**
 * 実行ユーザーのデータホーム DO(`evaluation:{userId}:primary`)の揮発 KV を取得する。
 *
 * 別ユーザーのボタン操作は別の論理 DO へ解決されるため、pendingId が一致しても他人の
 * pending は参照できない(所有者スコープを DO ルーティングで強制。domain 側でも userId 照合)。
 */
export async function getCheckinEphemeralKv(
  env: DiscordEnv,
  userId: string,
): Promise<CheckinEphemeralKv> {
  const stub = await getCycleAgent(env, userId, PRIMARY_CYCLE_KEY);
  return {
    put: (key, value) => stub.putEphemeral(key, value),
    get: (key) => stub.getEphemeral(key) as Promise<string | null>,
    delete: (key) => stub.deleteEphemeral(key),
  };
}

/** pending 分類を ephemeral KV へ不透明 JSON として保存する(task 3.2)。 */
export async function persistPendingClassification(
  kv: CheckinEphemeralKv,
  pending: PendingCheckinClassification,
): Promise<void> {
  await kv.put(pendingCheckinKey(pending.pendingId), JSON.stringify(pending));
}

/**
 * ephemeral KV から pending 分類を読み、単一エントリの {@link PendingCheckinStore} を組み立てる。
 *
 * 不在・JSON 破損・規約外の形は所有者照合不能として空 store を返す。domain の
 * `getPendingClassification`/`saveClassifiedCheckin`/`discardPendingClassification` は
 * 空 store に対して `not_found` を返すため、ハンドラはそのまま操作不可へ正規化できる。
 */
export async function hydratePendingStore(
  kv: CheckinEphemeralKv,
  pendingId: string,
): Promise<PendingCheckinStore> {
  const store = createPendingCheckinStore();
  const raw = await kv.get(pendingCheckinKey(pendingId));
  if (raw === null) {
    return store;
  }
  const pending = parsePendingClassification(raw);
  if (pending !== null) {
    store.classifications.set(pending.pendingId, pending);
  }
  return store;
}

/** 不透明 JSON 文字列を {@link PendingCheckinClassification} へ復元する(規約外は null)。 */
function parsePendingClassification(raw: string): PendingCheckinClassification | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPendingClassification(value)) {
    return null;
  }
  return value;
}

/** パース結果が pending 分類の形を満たすかを最小限で検証する(KV は非永続・自スペック書込のみ)。 */
function isPendingClassification(value: unknown): value is PendingCheckinClassification {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.pendingId === "string" &&
    typeof candidate.userId === "string" &&
    typeof candidate.cycleId === "string" &&
    typeof candidate.rawText === "string" &&
    typeof candidate.result === "object" &&
    candidate.result !== null &&
    Array.isArray((candidate.result as Record<string, unknown>).items)
  );
}
