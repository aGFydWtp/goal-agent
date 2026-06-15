type ClassificationPromptGoal = Readonly<{
  id: string;
  title: string;
  description: string;
  success_criteria: string | null;
}>;

export type BuildClassificationPromptInput = Readonly<{
  goals: ReadonlyArray<ClassificationPromptGoal>;
  rawText: string;
}>;

export type LlmPromptRequest = Readonly<{
  system: string;
  prompt: string;
}>;

export function buildClassificationPrompt({
  goals,
  rawText,
}: BuildClassificationPromptInput): LlmPromptRequest {
  const goalLines = goals
    .map(
      (goal, index) => `${index + 1}. id: ${goal.id}
   title: ${goal.title}
   description: ${goal.description}
   達成条件: ${goal.success_criteria ?? "未設定"}`,
    )
    .join("\n\n");

  return {
    system:
      "あなたは評価目標に対する週次チェックインを分類するアシスタントです。必ず指定された JSON 形式だけを返してください。",
    prompt: `以下の評価目標と達成条件を分類コンテキストとして、今週の入力を評価可能な項目へ分解してください。

## 目標一覧
${goalLines}

## 今週の入力
${rawText}

## 出力要件
- §13.1 の JSON 形式で返してください。
- トップレベルは items 配列です。
- items[].text には分解した入力項目を入れてください。
- items[].candidateGoals には関連する候補目標を配列で入れてください。
- candidateGoals[].goalId は上記の目標 id のみを使ってください。
- candidateGoals[].relevanceScore は 0 から 1 の数値にしてください。
- candidateGoals[].reason には目標・達成条件との関連理由を短く書いてください。
- items[].usefulness は low / medium / high のいずれかにしてください。
- items[].suggestedEvidenceTitle には証跡として保存するときの短いタイトルを入れてください。
- どの目標にも十分関連しない項目は未分類として保持し、candidateGoals: [] にしてください。

## JSON 形
{
  "items": [
    {
      "text": "入力から分解した項目",
      "candidateGoals": [
        {
          "goalId": "goal-id",
          "relevanceScore": 0.0,
          "reason": "関連理由"
        }
      ],
      "usefulness": "medium",
      "suggestedEvidenceTitle": "証跡タイトル"
    }
  ]
}`,
  };
}
