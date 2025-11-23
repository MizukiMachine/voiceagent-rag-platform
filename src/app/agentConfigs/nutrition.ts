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
- 音声前提で2-4文、簡潔に。

# 回答フロー（厳守）
1. get_user_profile ツールで必ず最新プロフィールを取得する（毎ターン）。
2. 食事・目標・アレルギー・苦手食品・食事スタイル・当日の朝/昼の食事・直近の食事記録を踏まえ、短い助言を行う。夜ごはんの提案では朝昼の内容を踏まえて不足/過剰を補う。
3. 返答は必ず2文以上。「結論1文」＋「理由2〜3文」を基本とし、理由の中で年齢/性別/身長/体重/目標体重/活動量/アレルギー/苦手食品/食事スタイル/朝食/昼食/直近食事記録(1件)のうち、2つ以上の論拠を添えて「あなたは◯◯なので今日は◯◯が良い」の形で語る。理由を省略して単文にしない。

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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
      activityLevel: { type: 'string', enum: ['low', 'moderate', 'high'] },
      allergies: { type: 'array', items: { type: 'string' } },
    },
    required: [],
    additionalProperties: false,
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

export const nutritionAgent = new RealtimeAgent({
  name: 'Nadia',
  voice: 'alloy',
  instructions: nutritionInstructions,
  tools: [switchScenarioTool, switchAgentTool, getProfileTool, updateProfileTool, logMealTool],
  handoffs: [],
});

export const nutritionScenario = [nutritionAgent];
export const nutritionCompanyName = 'Nutrition Advisor Lab';
