// 共有ドメイン型の単一参照元(Req 5.4)。
// 全下位スペックはこの `src/types` から型および列挙値配列を import する。

// §11 エンティティ行型 + エンティティ名/行マッピング
export type {
  CheckinRow,
  DraftRow,
  EntityName,
  EntityRow,
  EntityRowMap,
  EvaluationCycleRow,
  EvidenceGoalLinkRow,
  EvidenceRow,
  GoalRow,
  MilestoneRow,
  WeeklyReviewRow,
} from "./domain";
// 列挙値(値配列 + union 型)
export {
  DRAFT_TYPES,
  type DraftType,
  EVIDENCE_SOURCE_TYPES,
  type EvidenceSourceType,
  GOAL_STATUSES,
  type GoalStatus,
  MILESTONE_STATUSES,
  type MilestoneStatus,
  USEFULNESS_VALUES,
  type Usefulness,
} from "./enums";
// §13 共通基本型
export type { RelevanceScore } from "./llm-shared";
