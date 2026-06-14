import type {
  DraftContent,
  DraftEvidenceInput,
  RefineKind,
} from "./schema";

/** LLM へ渡すプロンプト要求(system + prompt)。 */
export interface DraftPromptRequest {
  system: string;
  prompt: string;
}

/**
 * 誇張抑制と推測明示の共通規約(Req 5.4, 6.2)。
 *
 * 生成・調整いずれのプロンプトでも維持する。strengthen(成果強調)でも
 * 事実の捏造・誇張を禁止し、証跡にない内容は推測として `speculativeNotes` に分離させる。
 */
const NO_FABRICATION_RULES = `- 保存済み証跡が裏付ける事実を誇張しないでください。
- 証跡にない内容は本文に断定で書かず、推測であることを明示して speculativeNotes 配列に入れてください。
- speculativeNotes には証跡で裏付けられない推測のみを入れ、推測がなければ空配列にしてください。`;

/** §13.3 のドラフト構成(4 セクション + 推測注記)の出力形式説明。 */
const DRAFT_OUTPUT_FORMAT = `## 出力要件(§13.3)
- 必ず次のキーを持つ JSON だけを返してください。
- facts: 事実。証跡に基づき何をしたかを記述します。
- interpretation: 解釈。その事実が目標にどう効いたかを記述します。
- issues: 課題。何が不足しているかを記述します。
- nextActions: 次アクション。今後どうするかを記述します。
- speculativeNotes: 証跡にない内容を推測として明示した文字列の配列です。
${NO_FABRICATION_RULES}

## JSON 形式
{
  "facts": "...",
  "interpretation": "...",
  "issues": "...",
  "nextActions": "...",
  "speculativeNotes": ["..."]
}`;

const DRAFT_SYSTEM =
  "あなたは評価目標の証跡から自己評価ドラフトを作成するアシスタントです。誇張せず、証跡にない内容は推測として分離し、必ず指定された JSON 形式だけを返してください。";

/**
 * §13.3 準拠の自己評価ドラフト生成プロンプトを組み立てる(Req 5.1, 5.4)。
 *
 * 対象証跡から事実/解釈/課題/次アクションを分離生成するよう指示し、誇張抑制と
 * 「証跡にない内容は推測明示」を必須規約として含める。`goalTitle` が null のときは
 * `/draft all`(半期全体)として「全体」を対象に記述させる。
 */
export function buildDraftPrompt(input: DraftEvidenceInput): DraftPromptRequest {
  const target = input.goalTitle ?? "半期全体";
  const scopeLabel = input.goalTitle === null ? "全体(全目標)" : input.goalTitle;

  const evidenceLines =
    input.evidence.length === 0
      ? "(証跡なし)"
      : input.evidence
          .map(
            (item, index) =>
              `${index + 1}. 日付: ${item.evidenceDate} / 有用度: ${item.usefulness}
   内容: ${item.body}`,
          )
          .join("\n");

  const prompt = `以下の保存済み証跡から、${target}の自己評価ドラフトを作成してください。
対象: ${scopeLabel}

## 保存済み証跡
${evidenceLines}

## 作成方針
- 上記の証跡のみを根拠に、事実・解釈・課題・次アクションを明確に分離して記述してください。
- 事実は証跡が示す内容に限定し、解釈は事実が目標にどう効いたかに絞ってください。

${DRAFT_OUTPUT_FORMAT}`;

  return { system: DRAFT_SYSTEM, prompt };
}

/** 調整 kind ごとの再生成方針(Req 6.1-6.4)。 */
const REFINE_INSTRUCTIONS: Record<RefineKind, string> = {
  shorten:
    "直前のドラフトを、要点を保ったままより簡潔で短い版に再生成してください。冗長な表現を削り、各セクションを引き締めてください。",
  strengthen:
    "直前のドラフトを、証跡が裏付ける成果をより強調した版に再生成してください。ただし事実を捏造せず誇張もせず、証跡にない内容は推測として speculativeNotes に分離したまま強調してください。",
  clarify:
    "直前のドラフトを、課題(issues)と次アクション(nextActions)をより具体的で明確にした版に再生成してください。何が不足し次に何をするかを読み手が把握できるようにしてください。",
  manager:
    "直前のドラフトを、上司・評価者が読むことを想定したトーン(manager_summary 相当)に調整した版に再生成してください。成果と進捗が評価者に伝わる簡潔で客観的な記述にしてください。",
};

const REFINE_SYSTEM =
  "あなたは既存の自己評価ドラフトを指示に従って再生成するアシスタントです。誇張せず、証跡にない内容は推測として分離し、必ず指定された JSON 形式だけを返してください。";

/**
 * 直前ドラフトと調整 kind から再生成プロンプトを組み立てる(Req 6.1-6.4)。
 *
 * 各 kind で意味的に異なる方針を与える。strengthen(成果強調)でも誇張・捏造を禁止し、
 * 推測明示の規約を維持する。再生成後も同じ 4 セクション + 推測注記の構造で返させる。
 */
export function buildRefinePrompt(
  prev: DraftContent,
  kind: RefineKind,
): DraftPromptRequest {
  const speculativeLines =
    prev.speculativeNotes.length === 0
      ? "(なし)"
      : prev.speculativeNotes.map((note) => `- ${note}`).join("\n");

  const prompt = `以下は直前に生成した自己評価ドラフトです。これを入力として調整版を再生成してください。

## 直前のドラフト
- 事実(facts): ${prev.facts}
- 解釈(interpretation): ${prev.interpretation}
- 課題(issues): ${prev.issues}
- 次アクション(nextActions): ${prev.nextActions}
- 推測注記(speculativeNotes):
${speculativeLines}

## 調整方針
${REFINE_INSTRUCTIONS[kind]}

${DRAFT_OUTPUT_FORMAT}`;

  return { system: REFINE_SYSTEM, prompt };
}
