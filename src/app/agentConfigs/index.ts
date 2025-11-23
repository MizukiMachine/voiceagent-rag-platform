import { graffityScenario, graffityCompanyName } from './graffity';
import { kateScenario, kateCompanyName } from './kate';
import { bashoScenario, bashoCompanyName } from './basho';
import { takubokuScenario, takubokuCompanyName } from './takuboku';
import { patriciaScenario, patriciaCompanyName } from './patricia';
import { markScenario, markCompanyName } from './mark';
import { nutritionScenario, nutritionCompanyName } from './nutrition';
import type { RealtimeAgent } from '@openai/agents/realtime';

// Map of scenario key -> array of RealtimeAgent objects
export const allAgentSets: Record<string, RealtimeAgent[]> = {
  graffity: graffityScenario,
  kate: kateScenario,
  basho: bashoScenario,
  takuboku: takubokuScenario,
  patricia: patriciaScenario,
  mark: markScenario,
  nutrition: nutritionScenario,
};

export type ScenarioMcpBinding = {
  requiredMcpServers: string[];
};

// 各シナリオが要求するMCPサーバーのキー（config.jsonの id と一致させる）
export const scenarioMcpBindings: Record<string, ScenarioMcpBinding> = {
  graffity: { requiredMcpServers: [] },
  kate: { requiredMcpServers: ['google-calendar'] },
  basho: { requiredMcpServers: [] },
  takuboku: { requiredMcpServers: [] },
  patricia: { requiredMcpServers: [] },
  mark: { requiredMcpServers: [] },
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
  basho: {
    label: 'バショウ (Haiku)',
    companyName: bashoCompanyName,
  },
  takuboku: {
    label: 'タクボク (Tanka)',
    companyName: takubokuCompanyName,
  },
  patricia: {
    label: 'パトリシア (Food Advisor)',
    companyName: patriciaCompanyName,
  },
  mark: {
    label: 'マーク (Meal Performance Advisor)',
    companyName: markCompanyName,
  },
  nutrition: {
    label: 'ナディア (栄養管理)',
    companyName: nutritionCompanyName,
  },
};
