// Agent ID 規約(仕様書 §6)の組立/分解ユーティリティ(design.md "Agent IDs + Routing")。
//
// 規約:
//   cycle: `evaluation:{userId}:{cycleId}`
//   goal:  `evaluation:{userId}:{cycleId}:goal:{goalId}`
//
// 不変条件(Req 3.2): 生成名は §6 規約に厳密準拠する。
// 往復一致(parse(build(...)) の一致)を曖昧にしないため、区切り文字 `:` を含む
// または空の id は組立側で拒否する。これにより不正な名前は決して生成されない。

const PREFIX = "evaluation";
const GOAL_MARKER = "goal";
const DELIMITER = ":";

/** 組立対象の id が空でなく、区切り文字 `:` を含まないことを検証する。 */
function assertSegment(value: string, label: string): void {
  if (value.length === 0) {
    throw new Error(`Agent ID segment "${label}" must not be empty`);
  }
  if (value.includes(DELIMITER)) {
    throw new Error(
      `Agent ID segment "${label}" must not contain the delimiter "${DELIMITER}": ${value}`,
    );
  }
}

/** `evaluation:{userId}:{cycleId}` を組み立てる。 */
export function cycleAgentName(userId: string, cycleId: string): string {
  assertSegment(userId, "userId");
  assertSegment(cycleId, "cycleId");
  return [PREFIX, userId, cycleId].join(DELIMITER);
}

/** `evaluation:{userId}:{cycleId}:goal:{goalId}` を組み立てる。 */
export function goalAgentName(userId: string, cycleId: string, goalId: string): string {
  assertSegment(userId, "userId");
  assertSegment(cycleId, "cycleId");
  assertSegment(goalId, "goalId");
  return [PREFIX, userId, cycleId, GOAL_MARKER, goalId].join(DELIMITER);
}

/**
 * Agent 名を種別付きで分解する。
 * 不正な文字列(プレフィックス不正・アリティ不正・空セグメント・goal マーカー不正)は
 * すべて null を返す。
 */
export function parseAgentName(
  name: string,
):
  | { kind: "cycle"; userId: string; cycleId: string }
  | { kind: "goal"; userId: string; cycleId: string; goalId: string }
  | null {
  const segments = name.split(DELIMITER);

  // 空セグメント(先頭/中間/末尾)は不正。
  if (segments.some((segment) => segment.length === 0)) {
    return null;
  }

  // プレフィックスは必ず `evaluation`。
  if (segments[0] !== PREFIX) {
    return null;
  }

  // cycle: [evaluation, userId, cycleId]
  if (segments.length === 3) {
    const [, userId, cycleId] = segments as [string, string, string];
    return { kind: "cycle", userId, cycleId };
  }

  // goal: [evaluation, userId, cycleId, goal, goalId]
  if (segments.length === 5 && segments[3] === GOAL_MARKER) {
    const [, userId, cycleId, , goalId] = segments as [string, string, string, string, string];
    return { kind: "goal", userId, cycleId, goalId };
  }

  return null;
}
