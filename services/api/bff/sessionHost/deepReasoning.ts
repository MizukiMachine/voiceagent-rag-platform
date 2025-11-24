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
  client: ResponsesClient;
  logger: StructuredLogger;
  logSampleLimit?: number;
}

export async function runDeepReasoning(options: DeepReasoningOptions): Promise<DeepReasoningResult> {
  const { question, client, logger, logSampleLimit = 800 } = options;
  const requestBody = buildDeepReasoningRequest(question);

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
      temperature: 0.2,
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

export function buildDeepReasoningRequest(question: string) {
  const systemPrompt =
    '日本語で回答してください。結論→理由→具体アクションの順で4〜6文。理由/論拠は活動量・食事ログ・goalTypeなどパーソナルデータや直近の食事内容を2〜3個必ず盛り込み、具体的に書いてください。';

  return {
    model: 'gpt-5.1',
    reasoning: { effort: 'high' },
    temperature: 0.4,
    max_output_tokens: 600,
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
            text: question,
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
