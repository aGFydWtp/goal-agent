// LLM 構造化入出力で共通利用される基本型(spec §13、Req 5.3)。
// 機能固有の I/O スキーマは各機能スペックが自前で組み立てる(境界 6.3)。

import type { GoalStatus, Usefulness } from "./enums";

/**
 * 関連度スコア(spec §13.1 relevanceScore)。
 * 意味的には 0..1 の範囲を取る連続値。型レベルでは number として表現し、
 * 範囲制約のバリデーションは下位スペックが担う。
 */
export type RelevanceScore = number;

// §13 で共通利用されるステータス値 / 有用度は enums.ts を単一の参照元とする
// (ここで再定義せず、re-export して参照経路を統一する)。
export type { GoalStatus, Usefulness };
