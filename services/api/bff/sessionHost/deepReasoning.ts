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

const DEFAULT_MAX_OUTPUT_TOKENS =
  Number(process.env.DEEP_REASONING_MAX_OUTPUT_TOKENS ?? '') || 4000;

export async function runDeepReasoning(options: DeepReasoningOptions): Promise<DeepReasoningResult> {
  const { question, profileContext, client, logger, logSampleLimit = 800, maxOutputTokens } = options;
  const requestBody = buildDeepReasoningRequest(question, maxOutputTokens, profileContext);

  let response: any;
  try {
    response = await client.create(requestBody as any);
  } catch (error) {
    logger.error('Deep reasoning responses.create failed', { error });
    throw error;
  }

  const { text, refusal } = extractOutputText(response);
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
    '日本語で回答してください。全体で3〜4文、200〜230文字目安で端的に。',
    '構成: 1文目=結論(料理スタイル＋主食/主菜/副菜を具体食材付きで列挙) / 2〜3文目=理由(プロフィールデータ由来の論拠を2つ以上) / 最終文=具体アクション(量の目安と調理/組み合わせ案、サプリで補うなら一言)。',
    '料理は「料理名＋食材」を2〜3品挙げる（例: 雑穀ご飯, 鮭の照り焼き150g, 小松菜と油揚げの味噌汁）。',
    '不足しがちな栄養はサプリ1つだけ提案（例: オメガ3/ビタミンD/鉄＋ビタミンC）。重複提案や総花的羅列はしない。',
    'スタイルを和/洋/ワンボウル/スープ多め等でローテーションし、現代の都市生活者向けに実用的・リアルな助言を。トーンは「肩の力を抜いた頼れる栄養士」。',
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
