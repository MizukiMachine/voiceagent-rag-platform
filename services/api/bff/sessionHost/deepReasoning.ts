import OpenAI from 'openai';

import type { StructuredLogger } from '../../../../framework/logging/structuredLogger';
import { buildResponseSummary } from './logging';

export type ResponsesClient = Pick<OpenAI['responses'], 'create'>;

export interface DeepReasoningResult {
  outcome: 'success' | 'refusal' | 'empty';
  text: string;
  refusal?: string;
  responseSummary: ReturnType<typeof buildResponseSummary>;
}

export interface DeepReasoningOptions {
  question: string;
  profileContext?: string;
  client: ResponsesClient;
  logger: StructuredLogger;
  logSampleLimit?: number;
  maxOutputTokens?: number;
}

const MAX_CHAR_LENGTH = 110;

const DEFAULT_MAX_OUTPUT_TOKENS = Math.min(Number(process.env.DEEP_REASONING_MAX_OUTPUT_TOKENS ?? '') || 300, 800);

export async function runDeepReasoning(options: DeepReasoningOptions): Promise<DeepReasoningResult> {
  const { question, profileContext, client, logger, logSampleLimit = 800, maxOutputTokens } = options;

  // 事前ウォームアップ（初回のモデル起動遅延を隠蔽）
  try {
    await warmupModel(client, logger);
  } catch (error) {
    logger.warn('Warmup failed; continuing anyway', { error });
  }

  const requestBody = buildDeepReasoningRequest(question, maxOutputTokens, profileContext);

  let response: any;
  try {
    response = await client.create(requestBody as any);
  } catch (error) {
    logger.error('Deep reasoning responses.create failed', { error });
    throw error;
  }

  let { text, refusal } = extractOutputText(response);
  if (text) {
    text = trimToMaxChars(text, MAX_CHAR_LENGTH);
  }
  const summary = buildResponseSummary(response, { text, refusal, limit: logSampleLimit });

  if (text && text.trim().length > 0) {
    return { outcome: 'success', text, refusal, responseSummary: summary };
  }

  if (refusal) {
    return { outcome: 'refusal', text: '', refusal, responseSummary: summary };
  }

  return { outcome: 'empty', text: '', refusal, responseSummary: summary };
}

export async function classifyDeepReasoningIntent(
  text: string,
  client: ResponsesClient,
  logger: StructuredLogger,
): Promise<boolean> {
  if (!text || text.trim().length === 0) return false;
  try {
    const res = await client.create({
      model: 'gpt-5-mini',
      max_output_tokens: 50,
      stream: false,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `次のユーザー発話は「深く考えてほしい／じっくり理由を述べてほしい」という意図を含みますか？含むならYES、含まないならNOだけ返してください。発話: ${text}`,
            },
          ],
        },
      ],
    });

    const output: any[] = Array.isArray((res as any).output) ? (res as any).output : [];
    const answer = output
      .flatMap((item: any) => item?.content ?? [])
      .map((c: any) => c?.text ?? c?.content?.[0]?.text ?? '')
      .filter(Boolean)
      .join(' ')
      .trim()
      .toUpperCase();

    return answer.includes('YES');
  } catch (error) {
    logger.warn('Deep reasoning intent classification failed; defaulting to no', {
      error,
    });
    return false;
  }
}

export function buildDeepReasoningRequest(question: string, maxOutputTokens?: number, profileContext?: string) {
  const systemPrompt = [
    '日本語で回答。全体3〜4文・90〜100文字目安。必要なら110文字まで伸ばしてもよいので、必ず自然に句点で完結させる。途中で切らない。',
    '構成: 1文目=結論(料理スタイル＋主食/主菜/副菜を具体食材付きで列挙) / 2〜3文目=理由(プロフィール由来の論拠を1つ以上: PFCバランス/GI/疲労・睡眠/目標) / 最終文=具体アクション(量目安＋調理/組み合わせ＋必要ならサプリ1つだけ)。',
    '料理は主食以外の「料理名」を2品。',
    'サプリは不足に応じて2つだけ（例: オメガ3/ビタミンD/鉄＋C/テアニン）。総花NG。和/洋/中華/等を日替わりで、都会的でリアルなアドバイスに。',
    '用語: 「冷奴」は必ず「ひややっこ」と読みを添えて書く。',
  ].join('\n');

  const enrichedQuestion = profileContext
    ? `${question}\n\nプロフィール情報（最新）:\n${profileContext}`
    : question;

  return {
    model: 'gpt-5.1',
    reasoning: { effort: 'medium' },
    max_output_tokens: maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    stream: false,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: systemPrompt,
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: enrichedQuestion,
          },
        ],
      },
    ],
  };
}

export function extractOutputText(response: any): { text: string; refusal?: string } {
  const outputs: any[] = Array.isArray(response?.output) ? response.output : [];
  const contents = outputs.flatMap((item: any) => normalizeContent(item?.content));

  const collected = contents
    .filter((c: any) => c?.type === 'output_text' && typeof c?.text === 'string')
    .map((c: any) => c.text)
    .filter(Boolean);

  if (collected.length > 0) {
    return { text: collected.join('\n') };
  }

  const refusal = contents.find((c: any) => c?.type === 'refusal')?.refusal ?? contents.find((c: any) => c?.refusal)?.refusal;
  if (refusal) {
    return { text: '', refusal };
  }

  const loose = contents
    .map((c: any) => (typeof c?.text === 'string' ? c.text : typeof c === 'string' ? c : ''))
    .filter((t: any) => typeof t === 'string' && t.trim().length > 0);

  if (loose.length > 0) {
    return { text: loose.join('\n') };
  }

  // legacy top-level fields
  if (typeof response?.output_text === 'string' && response.output_text.trim().length > 0) {
    return { text: response.output_text };
  }
  if (typeof response?.text === 'string' && response.text.trim().length > 0) {
    return { text: response.text };
  }

  const messageContent = normalizeContent(response?.message?.content).map((c: any) => c?.text).filter(Boolean);
  if (messageContent.length > 0) {
    return { text: messageContent.join('\n') };
  }

  return { text: '', refusal };
}

function normalizeContent(content: any): any[] {
  if (!content) return [];
  if (Array.isArray(content)) return content;
  return [content];
}

function trimToMaxChars(text: string, limit: number): string {
  if (!text || text.length <= limit) return text;

  // 少し余裕を見て句点まで許容する（ハード上限）
  const hardCap = limit + 20; // 最大20文字超過まで許容
  const slice = text.slice(0, hardCap);
  const punctuation = ['。', '！', '？', '!', '?', '．', '.', '、'];
  const lastPuncIndex = punctuation.reduce((max, p) => Math.max(max, slice.lastIndexOf(p)), -1);

  if (lastPuncIndex >= 0) {
    return slice.slice(0, lastPuncIndex + 1);
  }

  // 句読点が無ければハードキャップで返す（モデル側指示で句点を付けてもらう前提）
  return slice.trimEnd();
}

// 一度だけ Responses API に最小リクエストを送り、モデルのコールドスタート遅延を吸収する
export async function warmupModel(client: ResponsesClient, logger: StructuredLogger) {
  try {
    await client.create({
      model: 'gpt-5.1',
      max_output_tokens: 1,
      stream: false,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'ping' }],
        },
      ],
    } as any);
    logger.info('Deep reasoning warmup completed');
  } catch (error) {
    logger.warn('Deep reasoning warmup failed (non-fatal)', { error });
  }
}
