"use client";

import { useEffect, useMemo, useState } from 'react';

type ActivityLevel = 'low' | 'moderate' | 'high';
type Sex = 'male' | 'female' | 'other';
type GoalType = 'loss' | 'maintain' | 'gain';

type Profile = {
  userId: string;
  age?: number;
  sex?: Sex;
  heightCm?: number;
  weightKg?: number;
  goalType?: GoalType;
  activityLevel?: ActivityLevel;
  avoidFoods?: string;
  dietStyle?: string;
  mealLogs?: Array<{
    id: string;
    description: string;
    timeOfDay?: string;
    recordedAt: string;
  }>;
  todayMeals?: string;
  updatedAt: string;
  bmi?: number;
  estimatedTdeeKcal?: number;
  caloricBudgetAdvice?: string;
};

const activityLabels: Record<ActivityLevel, string> = {
  low: '低め（デスクワーク中心）',
  moderate: 'ふつう（軽い運動）',
  high: '高め（毎日運動）',
};

const sexLabels: Record<Sex, string> = {
  male: '男性',
  female: '女性',
  other: 'その他',
};

const fieldOrder: Array<keyof Profile> = [
  // 基本属性はプリセットでまとめて設定するため除外
  'goalType',
  'activityLevel',
  'avoidFoods',
  'dietStyle',
  'todayMeals',
];

const presets = [
  {
    id: 'male-35-176-65',
    label: '男性 35歳 176cm 65kg',
    values: { age: 35, sex: 'male' as Sex, heightCm: 176, weightKg: 65 },
  },
  {
    id: 'female-35-158-52',
    label: '女性 35歳 158cm 52kg',
    values: { age: 35, sex: 'female' as Sex, heightCm: 158, weightKg: 52 },
  },
];

type BusyState = 'idle' | 'loading' | 'saving' | 'resetting';

export default function ProfileDashboard({ clientTag = 'develop' }: { clientTag?: string }) {
  const [userId, setUserId] = useState('demo-user');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [busy, setBusy] = useState<BusyState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<string>('male-35-176-65');

  const summary = useMemo(() => buildSummary(profile), [profile]);
  const latestMeal = profile?.mealLogs?.at(-1);

  useEffect(() => {
    void loadProfile(userId);
  }, [userId, clientTag]);

  // プリセット選択時に基本属性をまとめてセット
  useEffect(() => {
    if (!profile) return;
    const preset = presets.find((p) => p.id === selectedPreset);
    if (!preset) return;
    const alreadyApplied =
      profile.age === preset.values.age &&
      profile.sex === preset.values.sex &&
      profile.heightCm === preset.values.heightCm &&
      profile.weightKg === preset.values.weightKg;
    if (alreadyApplied) return;
    setProfile({ ...profile, ...preset.values });
  }, [selectedPreset, profile]);

  async function loadProfile(targetUser: string) {
    setBusy('loading');
    setError(null);
    try {
      const params = new URLSearchParams({ user_id: targetUser, client_tag: clientTag });
      const res = await fetch(`/api/debug/profile?${params.toString()}`);
      const json = await res.json();
      setProfile(json.profile);
    } catch {
      setError('プロフィールの取得に失敗しました');
    } finally {
      setBusy('idle');
    }
  }

  async function saveProfile() {
    if (!profile) return;
    setBusy('saving');
    setError(null);
    setMessage(null);
    try {
      const payload = { clientTag, ...sanitizeForPatch(profile) };
      const res = await fetch('/api/debug/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.issues ? '入力値を確認してください' : '保存に失敗しました');
      } else {
        setProfile(json.profile);
        setMessage('保存しました。次の音声質問からこの値が使われます。');
      }
    } catch {
      setError('保存に失敗しました');
    } finally {
      setBusy('idle');
    }
  }

  async function resetProfile() {
    setBusy('resetting');
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/debug/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, resetAll: true, clientTag }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.issues ? 'リセットに失敗しました（入力値エラー）' : 'リセットに失敗しました');
      } else {
        setProfile(json.profile);
        setMessage('全項目を初期状態にリセットしました。');
      }
    } catch {
      setError('リセットに失敗しました');
    } finally {
      setBusy('idle');
    }
  }

  const onFieldChange = (key: keyof Profile, value: string) => {
    if (!profile) return;
    let nextValue: any = value;
    if (['age', 'heightCm', 'weightKg'].includes(key)) {
      nextValue = value === '' ? undefined : Number(value);
    }
    // avoidFoods は自由入力（カンマ区切りでない）
    setProfile({ ...profile, [key]: nextValue });
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-emerald-900 text-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-10">
        <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.2em] text-emerald-200">Nutrition Agent Demo</p>
            <h1 className="text-3xl font-semibold text-white">栄養管理ダッシュボード</h1>
            <p className="text-sm text-emerald-100">
              ここで編集した値が、音声エージェント「メアリー」の回答にそのまま反映されます。
            </p>
            <p className="mt-2 text-xs text-emerald-200">clientTag: {clientTag}</p>
          </div>
          <div className="flex gap-2 text-sm">
            <label className="flex items-center gap-2 rounded-lg bg-slate-800/70 px-3 py-2 ring-1 ring-emerald-500/40">
              <span className="text-emerald-100">User ID</span>
              <input
                className="w-32 rounded bg-slate-900 px-2 py-1 text-sm text-white outline-none ring-1 ring-emerald-500/40 focus:ring-emerald-400"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
              />
            </label>
            <button
              onClick={() => loadProfile(userId)}
              className="rounded-lg bg-emerald-500 px-3 py-2 font-semibold text-slate-900 hover:bg-emerald-400"
              disabled={busy !== 'idle'}
            >
              再読込
            </button>
          </div>
        </header>

        <section className="mt-8 grid gap-6 rounded-2xl bg-white/5 p-6 shadow-xl ring-1 ring-white/10 backdrop-blur">
          <div className="flex flex-wrap items-center gap-3 text-sm text-emerald-100">
            <span className="rounded-full bg-emerald-500/20 px-3 py-1 text-emerald-100">
              {busy === 'loading'
                ? '読込中...'
                : busy === 'saving'
                  ? '保存中...'
                  : busy === 'resetting'
                    ? 'リセット中...'
                    : '編集できます'}
            </span>
            {error && <span className="text-rose-200">{error}</span>}
            {message && <span className="text-emerald-200">{message}</span>}
          </div>

          {profile ? (
            <>
              <section className="rounded-xl bg-slate-900/70 p-4 ring-1 ring-white/10">
                <h2 className="text-base font-semibold text-white mb-3">基本プロフィールプリセット</h2>
                <div className="grid gap-3 text-base text-white md:grid-cols-2">
                  {presets.map((preset) => (
                    <label
                      key={preset.id}
                      className="flex cursor-pointer items-center gap-3 rounded-lg bg-slate-800/70 px-4 py-3 ring-1 ring-white/10 hover:ring-emerald-400 transition"
                    >
                      <input
                        type="radio"
                        name="profilePreset"
                        value={preset.id}
                        checked={selectedPreset === preset.id}
                        onChange={(e) => setSelectedPreset(e.target.value)}
                        className="accent-emerald-400 w-5 h-5"
                      />
                      <span className="font-semibold tracking-wide">{preset.label}</span>
                    </label>
                  ))}
                </div>
              </section>

              <div className="grid gap-4 md:grid-cols-2">
                {fieldOrder.map((field) => renderField(field, profile, onFieldChange))}
              </div>

          <div className="flex flex-wrap gap-3">
            <button
              onClick={saveProfile}
              disabled={busy !== 'idle'}
              className="rounded-xl bg-emerald-400 px-4 py-2 font-semibold text-slate-900 shadow-lg shadow-emerald-900/30 hover:bg-emerald-300 disabled:opacity-60"
            >
              保存してエージェントに反映
            </button>
            <button
              onClick={resetProfile}
              disabled={busy !== 'idle'}
              className="rounded-xl bg-rose-400 px-4 py-2 font-semibold text-slate-900 shadow-lg shadow-rose-900/30 hover:bg-rose-300 disabled:opacity-60"
            >
              すべてリセット
            </button>
            <p className="text-sm text-emerald-100">
              保存後、音声で「今日のランチどうする？」と聞くと最新プロフィールで回答が変わります。
            </p>
          </div>
            </>
          ) : (
            <div className="text-emerald-100">プロフィールを読み込み中...</div>
          )}
        </section>

        {profile && (
          <section className="mt-6 grid gap-4 rounded-2xl bg-slate-800/80 p-6 ring-1 ring-white/10">
            <h2 className="text-lg font-semibold text-white">利用プロフィールのサマリ</h2>
            <p className="text-sm text-emerald-100">{summary}</p>
            {latestMeal && (
              <p className="text-sm text-emerald-100">
                直近の食事記録: {latestMeal.timeOfDay ? `[${latestMeal.timeOfDay}] ` : ''}
                {latestMeal.description} ({new Date(latestMeal.recordedAt).toLocaleString()})
              </p>
            )}
            {profile.todayMeals && (
              <p className="text-sm text-emerald-100">今日の食事ログ: {profile.todayMeals}</p>
            )}
            <div className="grid gap-2 text-sm text-slate-100 md:grid-cols-3">
              <Metric label="BMI" value={profile.bmi ? profile.bmi.toFixed(1) : '未設定'} />
              <Metric
                label="推定TDEE"
                value={profile.estimatedTdeeKcal ? `${profile.estimatedTdeeKcal} kcal/日` : '未設定'}
              />
              <Metric
                label="カロリーバジェット"
                value={profile.caloricBudgetAdvice ?? '未計算（身長/体重/年齢を設定）'}
              />
              <Metric
                label="目標タイプ"
                value={
                  profile.goalType
                    ? profile.goalType === 'loss'
                      ? '減量'
                      : profile.goalType === 'gain'
                        ? '増量'
                        : '維持'
                    : '未設定'
                }
              />
              <Metric label="避けたい食品" value={profile.avoidFoods || 'なし/未設定'} />
              <Metric label="食事スタイル" value={profile.dietStyle || '未設定'} />
              <Metric label="最終更新" value={new Date(profile.updatedAt).toLocaleString()} />
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function renderField(
  key: keyof Profile,
  profile: Profile,
  onChange: (key: keyof Profile, value: string) => void,
) {
  const labelMap: Record<string, string> = {
    age: '年齢',
    sex: '性別',
    heightCm: '身長(cm)',
    weightKg: '体重(kg)',
    goalType: '目標タイプ',
    activityLevel: '活動量',
    avoidFoods: '避けたい食品（アレルギー・苦手を自由入力）',
    dietStyle: '食事スタイル（例: ベジタリアン/炭水化物控えめ）',
    todayMeals: '今日の食事ログ',
  };

  const value = profile[key];

  if (key === 'sex') {
    const selectValue = typeof value === 'string' ? value : '';
    return (
      <FieldShell key={key} label={labelMap[key]}>
        <select
          className="w-full rounded-lg bg-slate-800 px-3 py-2 text-white outline-none ring-1 ring-white/10 focus:ring-emerald-400"
          value={selectValue}
          onChange={(e) => onChange(key, e.target.value)}
        >
          <option value="">未設定</option>
          <option value="female">女性</option>
          <option value="male">男性</option>
          <option value="other">その他</option>
        </select>
      </FieldShell>
    );
  }

  if (key === 'activityLevel') {
    const selectValue =
      typeof value === 'string' ? value : '';
    return (
      <FieldShell key={key} label={labelMap[key]}>
        <select
          className="w-full rounded-lg bg-slate-800 px-3 py-2 text-white outline-none ring-1 ring-white/10 focus:ring-emerald-400"
          value={selectValue}
          onChange={(e) => onChange(key, e.target.value)}
        >
          <option value="">未設定</option>
          {(['low', 'moderate', 'high'] as ActivityLevel[]).map((lvl) => (
            <option key={lvl} value={lvl}>
              {activityLabels[lvl]}
            </option>
          ))}
        </select>
      </FieldShell>
    );
  }

  if (key === 'goalType') {
    const selectValue = typeof value === 'string' ? value : '';
    return (
      <FieldShell key={key} label={labelMap[key]}>
        <select
          className="w-full rounded-lg bg-slate-800 px-3 py-2 text-white outline-none ring-1 ring-white/10 focus:ring-emerald-400"
          value={selectValue}
          onChange={(e) => onChange(key, e.target.value)}
        >
          <option value="">未設定</option>
          <option value="loss">減量</option>
          <option value="maintain">維持</option>
          <option value="gain">増量</option>
        </select>
      </FieldShell>
    );
  }

  if (key === 'avoidFoods') {
    return (
      <FieldShell key={key} label={labelMap[key]}>
        <textarea
          className="w-full rounded-lg bg-slate-800 px-3 py-2 text-white outline-none ring-1 ring-white/10 focus:ring-emerald-400"
          rows={2}
          placeholder="例: 甲殻類アレルギー。揚げ物は避けたい。"
          value={(value as string | undefined) ?? ''}
          onChange={(e) => onChange(key, e.target.value)}
        />
      </FieldShell>
    );
  }
  if (key === 'dietStyle') {
    return (
      <FieldShell key={key} label={labelMap[key]}>
        <input
          className="w-full rounded-lg bg-slate-800 px-3 py-2 text-white outline-none ring-1 ring-white/10 focus:ring-emerald-400"
          placeholder="例: ベジタリアン、炭水化物控えめ、低脂質"
          value={(value as string | undefined) ?? ''}
          onChange={(e) => onChange(key, e.target.value)}
        />
      </FieldShell>
    );
  }
  if (key === 'todayMeals') {
    return (
      <FieldShell key={key} label={labelMap[key]}>
        <textarea
          className="w-full rounded-lg bg-slate-800 px-3 py-2 text-white outline-none ring-1 ring-white/10 focus:ring-emerald-400"
          rows={2}
          placeholder="例: 朝はヨーグルトとバナナ、昼は鶏むねサラダと玄米"
          value={(value as string | undefined) ?? ''}
          onChange={(e) => onChange(key, e.target.value)}
        />
      </FieldShell>
    );
  }

  return (
    <FieldShell key={key} label={labelMap[key]}>
      {(() => {
        const inputValue =
          typeof value === 'string' || typeof value === 'number' ? value : '';
        return (
          <input
            className="w-full rounded-lg bg-slate-800 px-3 py-2 text-white outline-none ring-1 ring-white/10 focus:ring-emerald-400"
            type="number"
            step="0.1"
            value={inputValue}
            onChange={(e) => onChange(key, e.target.value)}
          />
        );
      })()}
    </FieldShell>
  );
}

function FieldShell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-2 rounded-xl bg-slate-900/60 p-4 ring-1 ring-white/10">
      <span className="text-sm text-emerald-100">{label}</span>
      {children}
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/5 px-3 py-2 ring-1 ring-white/10">
      <p className="text-xs uppercase tracking-wide text-emerald-200">{label}</p>
      <p className="text-sm text-white">{value}</p>
    </div>
  );
}

function buildSummary(profile: Profile | null): string {
  if (!profile) return '—';
  const parts: string[] = [];
  if (profile.age) parts.push(`年齢${profile.age}歳`);
  if (profile.sex) parts.push(sexLabels[profile.sex]);
  if (profile.heightCm) parts.push(`身長${profile.heightCm}cm`);
  if (profile.weightKg) parts.push(`体重${profile.weightKg}kg`);
  if (profile.goalType) {
    const label = profile.goalType === 'loss' ? '減量' : profile.goalType === 'gain' ? '増量' : '維持';
    parts.push(`目標タイプ:${label}`);
  }
  if (profile.activityLevel) parts.push(activityLabels[profile.activityLevel]);
  if (profile.avoidFoods) parts.push(`避けたい食品:${profile.avoidFoods}`);
  if (profile.dietStyle) parts.push(`スタイル:${profile.dietStyle}`);
  if (profile.todayMeals) parts.push(`今日の食事:${profile.todayMeals}`);
  return parts.join(' / ') || '未設定項目が多いため、追加で入力してください。';
}

function sanitizeForPatch(profile: Profile) {
  const {
    userId,
    age,
    sex,
    heightCm,
    weightKg,
    goalType,
    activityLevel,
    avoidFoods,
    dietStyle,
    todayMeals,
  } = profile;
  return {
    userId,
    age: numberOrUndefined(age),
    sex,
    heightCm: numberOrUndefined(heightCm),
    weightKg: numberOrUndefined(weightKg),
    goalType,
    activityLevel,
    avoidFoods: stringOrUndefined(avoidFoods),
    dietStyle: stringOrUndefined(dietStyle),
    todayMeals: stringOrUndefined(todayMeals),
  };
}

function numberOrUndefined(val: number | undefined) {
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

function stringOrUndefined(val: string | undefined) {
  return typeof val === 'string' && val.trim() ? val.trim() : undefined;
}
