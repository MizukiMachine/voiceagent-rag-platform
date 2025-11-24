import { RealtimeAgent, tool } from '@openai/agents/realtime';

import { japaneseLanguagePreamble, commonInteractionRules, voiceResponsePreamble, buildSelfIntroductionRule } from './languagePolicy';
import { switchAgentTool, switchScenarioTool } from './voiceControlTools';

function resolveProfileApiBase(): string {
  if (typeof window === 'undefined') {
    // サーバー側（BFF）で実行されるツール呼び出し
    return process.env.INTERNAL_PROFILE_API_BASE ?? 'http://localhost:3000';
  }
  // ブラウザ側（将来クライアントツールで使う場合）
  return process.env.NEXT_PUBLIC_PROFILE_API_BASE ?? '';
}

function buildApiUrl(path: string): string {
  const base = resolveProfileApiBase();
  if (!base) return path;
  return new URL(path, base).toString();
}

const nutritionInstructions = `
${japaneseLanguagePreamble}
${voiceResponsePreamble}
${buildSelfIntroductionRule('Nadia')}
${commonInteractionRules}
あなたは「栄養管理アドバイザーNadia」です。必ず最新のプロフィールをデータベース（ツール）から取得してから助言します。会話メモリよりもDBの値を常に優先し、プロフィールを箇条書きで羅列せず「あなたは◯◯なので今日は◯◯が良い」の文脈に織り込んで説明します。

# 安全・トーン
- 医療行為は行わず、疾患が疑われる場合は専門医受診を勧める。
- 極端なカロリー制限や過剰摂取を推奨しない（目安±400kcal/日以内）。
- 音声前提で3〜4文、200〜260文字目安で簡潔に。

# 回答フロー（厳守）
1. get_user_profile ツールで必ず最新プロフィールを取得する（毎ターン）。
2. 食事・目標・アレルギー・苦手食品・食事スタイル・当日の朝/昼の食事・直近の食事記録を踏まえ、短い助言を行う。夜ごはんの提案では朝昼の内容を踏まえて不足/過剰を補う。
3. 返答は必ず2文以上。「結論1文」＋「理由2〜3文」を基本とし、理由の中で 活動量/アレルギー/苦手食品/食事スタイル/朝食/昼食/直近食事記録のうち、2つ以上の論拠を添えて「あなたは◯◯なので今日は◯◯が良い」の形で語る。理由を省略して単文にしない。

# 表現ポリシー（深考スタイルに揃える）
- サーバ深考が返す指針: 3〜4文・200〜230文字、料理名＋具体食材を2〜3品、理由はプロフィール由来の論拠を2つ以上、最後に量の目安と必要ならサプリ1つだけ（オメガ3/ビタミンD/鉄＋C等）。
- 日替わり感: 和/洋/ワンボウル/スープ多めをローテーションし、同じ型に寄りすぎない。
- トーン: 現代の都市生活者向けにリアルで実用的、肩の力を抜いた頼れる栄養士。
- 禁止: 総花的羅列・冗長な前置き・同一フォーマットの繰り返し。

# 目標タイプの扱い
- プロフィールのgoalType（loss=減量 / maintain=維持 / gain=増量）を最優先で用い、未設定時のみ目標体重と現在体重の差から推定する。
- カロリー目安の基準：減量→推定TDEE-400kcal前後、増量→TDEE+300kcal前後、維持→TDEE。
- 結論の1文目で「減量モード」「増量モード」「維持モード」など目標タイプを織り込む。

# 深く考えるモード
- 食事アドバイスは常にサーバ側で Responses API (gpt-5.1, reasoning.effort=medium) を先行実行する。サーバから受け取った回答案を崩さず 3〜4文で「結論→理由→具体アクション」の順に話す。
- サーバ処理開始時にプレースホルダー（例:「少々お待ちください。丁寧に考えています…」）が届く想定。届いたらそのまま一言伝え、続けて最終回答を返す。
- サーバ深考が失敗/無応答だった場合のみバックアップとして deep_reasoning ツールを使って同等の回答案を生成し、2〜4文で返す。
- 料理画像への「名前/カロリーは？」といった質問は深考に回さずリアルタイムで即答する。

# 補助ルール
- プロフィールの空欄は「未設定」として扱い、追加で聞く必要があれば一言で依頼する。
- 直近の食事ログがない場合は、時間帯別の簡易提案を返す。
- 画像が来た場合は主要料理と量を簡潔に言語化し、推定カロリーをレンジで伝える。
`;

const getProfileTool = tool({
  name: 'get_user_profile',
  description: '最新のユーザープロフィールを取得します。常に回答前に呼び出してください。',
  parameters: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'ユーザーID。省略時はデフォルトデモユーザー。' },
    },
    required: [],
    additionalProperties: false,
  },
  execute: async (input: any) => {
    const userId = typeof input?.userId === 'string' ? input.userId : undefined;
    const query = userId ? `?user_id=${encodeURIComponent(userId)}` : '';
    const res = await fetch(buildApiUrl(`/api/debug/profile${query}`), {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`profile fetch failed: ${res.status}`);
    }
    const json = await res.json();
    return json.profile;
  },
});

const updateProfileTool = tool({
  name: 'update_user_profile',
  description: 'デモ用途。プロフィールを更新して保存します。通常はダッシュボードから操作されます。',
  parameters: {
    type: 'object',
    properties: {
      userId: { type: 'string' },
      age: { type: 'number' },
      sex: { type: 'string', enum: ['male', 'female', 'other'] },
      heightCm: { type: 'number' },
      weightKg: { type: 'number' },
      targetWeightKg: { type: 'number' },
      goalType: { type: 'string', enum: ['loss', 'maintain', 'gain'] },
      activityLevel: { type: 'string', enum: ['low', 'moderate', 'high'] },
      allergies: { type: 'array', items: { type: 'string' } },
    },
    required: [],
    additionalProperties: false,
  },
  execute: async (input: any) => {
    const res = await fetch(buildApiUrl('/api/debug/profile'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input ?? {}),
    });
    if (!res.ok) {
      throw new Error(`profile update failed: ${res.status}`);
    }
    const json = await res.json();
    return json.profile;
  },
});

const logMealTool = tool({
  name: 'log_meal',
  description: '簡易食事ログ（デモ用、実際の保存は行わず、応答メッセージに活用する）。',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: '食事の内容' },
      time: { type: 'string', description: '食事の時間（任意）' },
    },
    required: ['description'],
    additionalProperties: false,
  },
  execute: async (input: any) => {
    const description = typeof input?.description === 'string' ? input.description : '';
    const time = typeof input?.time === 'string' ? input.time : undefined;
    return {
      status: 'logged',
      note: 'デモ環境のため、記録はメモリ内のみで永続化しません。',
      meal: { description, time },
    };
  },
});

const deepReasoningTool = tool({
  name: 'deep_reasoning',
  description:
    'サーバ側の深考処理が失敗したときのバックアップ。Responses APIで gpt-5.1 + reasoning.effort=medium を使い、食事アドバイス案を再生成する。',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'ユーザーからの最新の質問や依頼（日本語）' },
      context: {
        type: 'string',
        description: '補足となるプロフィールや直近の食事内容など（省略可）',
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
  execute: async (input: any) => {
    const question = typeof input?.question === 'string' ? input.question : '';
    const context = typeof input?.context === 'string' ? input.context : '';

    const prompt = [question, context].filter(Boolean).join('\n\n補足情報: ');

    const body = {
      model: 'gpt-5.1',
      reasoning: { effort: 'medium' },
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `日本語で丁寧かつ簡潔に回答してください。必ず結論→理由→具体アクションの順で3〜5文。質問: ${prompt}`,
            },
          ],
        },
      ],
      max_output_tokens: 600,
    };

    const res = await fetch('/api/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`deep_reasoning failed: ${res.status}`);
    }

    const json = await res.json();
    const outputItems: any[] = Array.isArray(json.output) ? json.output : [];
    const text = outputItems
      .flatMap((item) => item?.content ?? [])
      .filter((c: any) => c?.type === 'output_text')
      .map((c: any) => c.text)
      .join('\n');

    return { text: text || '詳細回答を取得できませんでした。' };
  },
});

export const nutritionAgent = new RealtimeAgent({
  name: 'Nadia',
  voice: 'coral',
  instructions: nutritionInstructions,
  tools: [switchScenarioTool, switchAgentTool, getProfileTool, updateProfileTool, logMealTool, deepReasoningTool],
  handoffs: [],
});

export const nutritionScenario = [nutritionAgent];
export const nutritionCompanyName = 'Nutrition Advisor Lab';
