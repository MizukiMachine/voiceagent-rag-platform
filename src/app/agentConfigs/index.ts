import { graffityScenario, graffityCompanyName } from './graffity';
import { b2bRagScenario, b2bRagCompanyName } from './b2bRag';
import type { RealtimeAgent } from '@openai/agents/realtime';

// Map of scenario key -> array of RealtimeAgent objects
export const allAgentSets: Record<string, RealtimeAgent<any>[]> = {
  graffity: graffityScenario,
  b2b_rag: b2bRagScenario,
};

export type ScenarioMcpBinding = {
  requiredMcpServers: string[];
};

// 各シナリオが要求するMCPサーバーのキー（config.jsonの id と一致させる）
export const scenarioMcpBindings: Record<string, ScenarioMcpBinding> = {
  graffity: { requiredMcpServers: [] },
  b2b_rag: { requiredMcpServers: [] },
};

export const defaultAgentSetKey = 'graffity';

export const agentSetMetadata: Record<string, { label: string; companyName: string }> = {
  graffity: {
    label: 'Graffity (Default)',
    companyName: graffityCompanyName,
  },
  b2b_rag: {
    label: 'B2B RAG (File Search)',
    companyName: b2bRagCompanyName,
  },
};
