import { tool } from '@openai/agents/realtime';

type ScenarioChangeHandler = (scenarioKey: string) => Promise<{ success: boolean; message?: string }>;
type AgentChangeHandler = (agentName: string) => Promise<{ success: boolean; message?: string }>;

export const switchScenarioTool = tool({
  name: 'switchScenario',
  description:
    'Switches the entire conversation to a different scenario (graffity, kate, nutrition, or takuboku). Use when the user explicitly requests a different experience.',
  parameters: {
    type: 'object',
    properties: {
      scenarioKey: {
        type: 'string',
        description: 'The scenario identifier to switch to (graffity, kate, nutrition, or takuboku).',
      },
    },
    required: ['scenarioKey'],
    additionalProperties: false,
  },
  execute: async (input, details) => {
    const ctx = (details?.context ?? {}) as any;
    const handler: ScenarioChangeHandler | undefined =
      ctx?.requestScenarioChange ?? ctx?.voiceControl?.requestScenarioChange;
    if (!handler) {
      return { success: false, message: 'Scenario switching is unavailable right now.' };
    }
    try {
      return await handler((input as { scenarioKey: string }).scenarioKey);
    } catch (error: any) {
      return { success: false, message: error?.message ?? 'Failed to switch scenario.' };
    }
  },
});

export const switchAgentTool = tool({
  name: 'switchAgent',
  description:
    'Switches to another agent within the current scenario (for example, jump directly to the sales or returns specialist). Use only after confirming the user wants a specific agent.',
  parameters: {
    type: 'object',
    properties: {
      agentName: {
        type: 'string',
        description: 'Exact name of the agent to activate (must exist in the current scenario).',
      },
    },
    required: ['agentName'],
    additionalProperties: false,
  },
  execute: async (input, details) => {
    const ctx = (details?.context ?? {}) as any;
    const handler: AgentChangeHandler | undefined =
      ctx?.requestAgentChange ?? ctx?.voiceControl?.requestAgentChange;
    if (!handler) {
      return { success: false, message: 'Agent switching is unavailable right now.' };
    }
    try {
      return await handler((input as { agentName: string }).agentName);
    } catch (error: any) {
      return { success: false, message: error?.message ?? 'Failed to switch agent.' };
    }
  },
});
