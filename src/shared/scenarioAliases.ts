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
  kate: ['kate',
    'ケイト',
    // 'ケイ',
    // 'けい',
    'ケイと',
    'ｹｲﾄ',
    'けいと',
    'けーと',
    'Kと',
    'kateシナリオ',
    'ケイトシナリオ',
    'Kejto',
    'Keito',
    'Kato',
    'Kaito',
    'kaito',
    '桂都',
    '形と',
    ],
  takuboku: [
    'takuboku',
    '啄木',
    '拓木',
    '拓僕',
    'たくぼく',
    'たくぼくう',
    'タクボク',
    'タカボク',
    'たかぼく',
    '僕',
    'ぼく',
    'ボク',
    '宅録',
  ],
  nutrition: [
    'mary',
    'メアリー',
    'めありー',
    'メアリ',
    'めあり',
    'メリー',
    'めりー',
    'mery',
    'meri',
    'マリー',
    'まりー',
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
