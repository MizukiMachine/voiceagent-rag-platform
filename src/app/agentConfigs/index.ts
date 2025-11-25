import { graffityScenario, graffityCompanyName } from './graffity';
import { kateScenario, kateCompanyName } from './kate';
import { takubokuScenario, takubokuCompanyName } from './takuboku';
import { nutritionScenario, nutritionCompanyName } from './nutrition';
import type { RealtimeAgent } from '@openai/agents/realtime';

// Map of scenario key -> array of RealtimeAgent objects
export const allAgentSets: Record<string, RealtimeAgent<any>[]> = {
  graffity: graffityScenario,
  kate: kateScenario,
  takuboku: takubokuScenario,
  nutrition: nutritionScenario,
};

export type ScenarioMcpBinding = {
  requiredMcpServers: string[];
};

// 各シナリオが要求するMCPサーバーのキー（config.jsonの id と一致させる）
export const scenarioMcpBindings: Record<string, ScenarioMcpBinding> = {
  graffity: { requiredMcpServers: [] },
  kate: { requiredMcpServers: ['google-calendar'] },
  takuboku: { requiredMcpServers: [] },
  nutrition: { requiredMcpServers: [] },
};

export const defaultAgentSetKey = 'graffity';

export const agentSetMetadata: Record<string, { label: string; companyName: string }> = {
  graffity: {
    label: 'Graffity (Default)',
    companyName: graffityCompanyName,
  },
  kate: {
    label: 'ケイト (Google Calendar MCP)',
    companyName: kateCompanyName,
  },
  takuboku: {
    label: 'タクボク (Tanka)',
    companyName: takubokuCompanyName,
  },
  nutrition: {
    label: 'メアリー (栄養管理)',
    companyName: nutritionCompanyName,
  },
};
