import { describe, it, expect } from 'vitest';

import { scenarioMcpBindings } from '../index';

describe('scenarioMcpBindings', () => {
  it('requires no MCP servers for graffity', () => {
    const enabled = Object.entries(scenarioMcpBindings)
      .filter(([, binding]) => (binding.requiredMcpServers ?? []).length > 0)
      .map(([key]) => key);

    expect(enabled).toEqual([]);
    expect(scenarioMcpBindings.graffity.requiredMcpServers).toEqual([]);
  });
});
