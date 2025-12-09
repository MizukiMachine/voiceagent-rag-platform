import { tool } from '@openai/agents/realtime';
import { z } from 'zod';

type RagServiceHandle = {
  searchDocuments: (params: {
    query: string;
    topK?: number;
    filter?: string;
    scenarioKey?: string;
    clientTag?: string;
  }) => Promise<any>;
};

export const docSearchTool = tool({
  name: 'doc_search',
  description:
    'Gemini File Search で社内ドキュメントを検索し、引用できる抜粋を返す。製品/仕様/手順など事実確認が必要な質問で呼び出す。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '検索クエリ（日本語可）' },
      topK: { type: 'number', description: '取得する件数 (1-10)', minimum: 1, maximum: 10 },
      filter: {
        type: 'string',
        description: 'File Search の filter 句（例: mimeType:pdf AND labels:"Internal"）',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  execute: async (input, details) => {
    const ctx = (details?.context ?? {}) as {
      ragService?: RagServiceHandle;
      scenarioKey?: string;
      clientTag?: string;
    };
    if (!ctx.ragService || typeof ctx.ragService.searchDocuments !== 'function') {
      return {
        success: false,
        message: 'RAG retriever is not configured on the server.',
      };
    }
    const schema = z.object({
      query: z.string().min(1),
      topK: z.number().int().min(1).max(10).optional(),
      filter: z.string().trim().min(1).optional(),
    });
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        message: `Invalid doc_search parameters: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      };
    }
    const { query, topK, filter } = parsed.data;
    try {
      const result = await ctx.ragService.searchDocuments({
        query,
        topK,
        filter,
        scenarioKey: ctx.scenarioKey,
        clientTag: ctx.clientTag,
      });
      return {
        success: true,
        result,
      };
    } catch (error: any) {
      return {
        success: false,
        message: error?.message ?? 'doc_search failed',
      };
    }
  },
});
