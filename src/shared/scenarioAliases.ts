export const scenarioAliasMap: Record<string, string[]> = {
  graffity: [
    'graffity',
    'graffiti',
    'グラフィティ',
    'グラフィティー',
    'グラフティ',
    'グラフティー',
    'ぐらふぃてぃ',
    'グラビティ', // よくある誤転写
    'クロクティ',
    'グラフィー',
    'グラプティブ',
    'ブラクティ',
    // 'グラ',
    // 'ぐら',
    // 'ｸﾞﾗ',
    'Grafty',
    'grafty',
    'Graphy',
    'graphy',
    'Grafiti',
    'grafiti',
    'Graphiti',
    'graphiti',
    'Grażty',
    'Crafty',
    'grašti',
  ],
  b2b_rag: [
    'b2b',
    'B2B',
    'b2b rag',
    'b2bドキュメント',
    'ドキュメント検索',
    '資料検索',
    '法人rag',
    '企業rag',
  ],
};

const aliasLookup = Object.entries(scenarioAliasMap).reduce<Record<string, string>>((acc, [key, aliases]) => {
  aliases.forEach((alias) => {
    const normalized = alias.trim().toLowerCase();
    if (normalized) {
      acc[normalized] = key;
    }
  });
  acc[key] = key;
  return acc;
}, {});

export function normalizeScenarioKey(raw?: string | null): string {
  if (!raw) return raw ?? '';
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  return aliasLookup[lower] ?? aliasLookup[trimmed] ?? lower;
}
