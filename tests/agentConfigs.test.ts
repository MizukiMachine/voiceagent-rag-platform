import { describe, expect, it } from 'vitest';

import {
  allAgentSets,
  agentSetMetadata,
  defaultAgentSetKey,
} from '@/app/agentConfigs';

const EXPECTED_SCENARIOS = ['graffity', 'kate', 'basho', 'takuboku', 'patricia', 'mark'];

describe('agentConfigs', () => {
  it('公開シナリオをMed/Tech抜きの許可リストに限定する', () => {
    const keys = Object.keys(allAgentSets).sort();
    expect(keys).toEqual([...EXPECTED_SCENARIOS].sort());
  });

  it('メタデータのキーも許可シナリオと一致する', () => {
    const metaKeys = Object.keys(agentSetMetadata).sort();
    expect(metaKeys).toEqual([...EXPECTED_SCENARIOS].sort());
  });

  it('デフォルトシナリオがGraffityに設定されている', () => {
    expect(defaultAgentSetKey).toBe('graffity');
    expect(allAgentSets[defaultAgentSetKey]).toBeDefined();
  });

  it('Graffityシナリオが1人目のエージェントとしてGraffityを持つ', () => {
    const graffity = allAgentSets.graffity;
    expect(graffity).toBeDefined();
    expect(graffity[0]?.name).toBe('Graffity');
  });
});
