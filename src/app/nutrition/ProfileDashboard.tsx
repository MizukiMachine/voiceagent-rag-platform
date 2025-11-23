/* eslint-disable react-hooks/exhaustive-deps */
"use client";

import { useEffect, useMemo, useState } from 'react';

type ActivityLevel = 'low' | 'moderate' | 'high';
type Sex = 'male' | 'female' | 'other';

type Profile = {
  userId: string;
  age?: number;
  sex?: Sex;
  heightCm?: number;
  weightKg?: number;
  targetWeightKg?: number;
  activityLevel?: ActivityLevel;
  allergies?: string[];
  dislikedFoods?: string[];
  dietStyle?: string;
  mealLogs?: Array<{
    id: string;
    description: string;
    timeOfDay?: string;
    recordedAt: string;
  }>;
  todayBreakfast?: string;
  todayLunch?: string;
  updatedAt: string;
  bmi?: number;
  weightDeltaKg?: number;
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
  'age',
  'sex',
  'heightCm',
  'weightKg',
  'targetWeightKg',
  'activityLevel',
  'allergies',
  'dislikedFoods',
  'dietStyle',
  'todayBreakfast',
  'todayLunch',
];

type BusyState = 'idle' | 'loading' | 'saving';

export default function ProfileDashboard() {
  const [userId, setUserId] = useState('demo-user');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [busy, setBusy] = useState<BusyState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const summary = useMemo(() => buildSummary(profile), [profile]);
  const latestMeal = profile?.mealLogs?.at(-1);

  useEffect(() => {
    void loadProfile(userId);
  }, [userId]);

  async function loadProfile(targetUser: string) {
    setBusy('loading');
    setError(null);
    try {
      const res = await fetch(`/api/debug/profile?user_id=${encodeURIComponent(targetUser)}`);
      const json = await res.json();
      setProfile(json.profile);
    } catch (e: any) {
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
      const payload = sanitizeForPatch(profile);
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
    } catch (e: any) {
      setError('保存に失敗しました');
    } finally {
      setBusy('idle');
    }
  }

  const onFieldChange = (key: keyof Profile, value: string) => {
    if (!profile) return;
    let nextValue: any = value;
    if (['age', 'heightCm', 'weightKg', 'targetWeightKg'].includes(key)) {
      nextValue = value === '' ? undefined : Number(value);
    }
    if (key === 'allergies') {
      nextValue = value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    }
    if (key === 'dislikedFoods') {
      nextValue = value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    }
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
              ここで編集した値が、音声エージェント「ナディア」の回答にそのまま反映されます。
            </p>
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
              {busy === 'loading' ? '読込中...' : busy === 'saving' ? '保存中...' : '編集できます'}
            </span>
            {error && <span className="text-rose-200">{error}</span>}
            {message && <span className="text-emerald-200">{message}</span>}
          </div>

          {profile ? (
            <>
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
            <div className="grid gap-2 text-sm text-slate-100 md:grid-cols-3">
              <Metric label="BMI" value={profile.bmi ? profile.bmi.toFixed(1) : '未設定'} />
              <Metric
                label="目標差分"
                value={
                  profile.weightDeltaKg !== undefined
                    ? `${profile.weightDeltaKg > 0 ? '+' : ''}${profile.weightDeltaKg} kg`
                    : '未設定'
                }
              />
              <Metric
                label="推定TDEE"
                value={profile.estimatedTdeeKcal ? `${profile.estimatedTdeeKcal} kcal/日` : '未設定'}
              />
              <Metric
                label="カロリーバジェット"
                value={profile.caloricBudgetAdvice ?? '未計算（身長/体重/年齢を設定）'}
              />
              <Metric label="アレルギー" value={profile.allergies?.join(', ') || 'なし/未設定'} />
              <Metric label="苦手な食品" value={profile.dislikedFoods?.join(', ') || 'なし/未設定'} />
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
    targetWeightKg: '目標体重(kg)',
    activityLevel: '活動量',
    allergies: 'アレルギー（カンマ区切り）',
    dislikedFoods: '苦手な食品（カンマ区切り）',
    dietStyle: '食事スタイル（例: ベジタリアン/炭水化物控えめ）',
    todayBreakfast: '今日の朝ごはん',
    todayLunch: '今日の昼ごはん',
  };

  const value = profile[key];

  if (key === 'sex') {
    return (
      <FieldShell key={key} label={labelMap[key]}>
        <select
          className="w-full rounded-lg bg-slate-800 px-3 py-2 text-white outline-none ring-1 ring-white/10 focus:ring-emerald-400"
          value={value ?? ''}
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
    return (
      <FieldShell key={key} label={labelMap[key]}>
        <select
          className="w-full rounded-lg bg-slate-800 px-3 py-2 text-white outline-none ring-1 ring-white/10 focus:ring-emerald-400"
          value={value ?? ''}
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

  if (key === 'allergies') {
    return (
      <FieldShell key={key} label={labelMap[key]}>
        <input
          className="w-full rounded-lg bg-slate-800 px-3 py-2 text-white outline-none ring-1 ring-white/10 focus:ring-emerald-400"
          placeholder="例: peanut, shrimp"
          value={(value as string[] | undefined)?.join(', ') ?? ''}
          onChange={(e) => onChange(key, e.target.value)}
        />
      </FieldShell>
    );
  }
  if (key === 'dislikedFoods') {
    return (
      <FieldShell key={key} label={labelMap[key]}>
        <input
          className="w-full rounded-lg bg-slate-800 px-3 py-2 text-white outline-none ring-1 ring-white/10 focus:ring-emerald-400"
          placeholder="例: ピーマン, セロリ"
          value={(value as string[] | undefined)?.join(', ') ?? ''}
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
  if (key === 'todayBreakfast' || key === 'todayLunch') {
    return (
      <FieldShell key={key} label={labelMap[key]}>
        <textarea
          className="w-full rounded-lg bg-slate-800 px-3 py-2 text-white outline-none ring-1 ring-white/10 focus:ring-emerald-400"
          rows={2}
          placeholder={key === 'todayBreakfast' ? '例: ごはん、鮭、味噌汁' : '例: 玄米と鶏むね肉、サラダ'}
          value={(value as string | undefined) ?? ''}
          onChange={(e) => onChange(key, e.target.value)}
        />
      </FieldShell>
    );
  }

  return (
    <FieldShell key={key} label={labelMap[key]}>
      <input
        className="w-full rounded-lg bg-slate-800 px-3 py-2 text-white outline-none ring-1 ring-white/10 focus:ring-emerald-400"
        type="number"
        step="0.1"
        value={value ?? ''}
        onChange={(e) => onChange(key, e.target.value)}
      />
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
  if (profile.targetWeightKg) parts.push(`目標${profile.targetWeightKg}kg`);
  if (profile.activityLevel) parts.push(activityLabels[profile.activityLevel]);
  if (profile.allergies?.length) parts.push(`アレルギー:${profile.allergies.join(',')}`);
  if (profile.dislikedFoods?.length) parts.push(`苦手:${profile.dislikedFoods.join(',')}`);
  if (profile.dietStyle) parts.push(`スタイル:${profile.dietStyle}`);
  return parts.join(' / ') || '未設定項目が多いため、追加で入力してください。';
}

function sanitizeForPatch(profile: Profile) {
  const {
    userId,
    age,
    sex,
    heightCm,
    weightKg,
    targetWeightKg,
    activityLevel,
    allergies,
    dislikedFoods,
    dietStyle,
    todayBreakfast,
    todayLunch,
  } = profile;
  return {
    userId,
    age: numberOrUndefined(age),
    sex,
    heightCm: numberOrUndefined(heightCm),
    weightKg: numberOrUndefined(weightKg),
    targetWeightKg: numberOrUndefined(targetWeightKg),
    activityLevel,
    allergies,
    dislikedFoods,
    dietStyle: stringOrUndefined(dietStyle),
    todayBreakfast: stringOrUndefined(todayBreakfast),
    todayLunch: stringOrUndefined(todayLunch),
  };
}

function numberOrUndefined(val: number | undefined) {
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

function stringOrUndefined(val: string | undefined) {
  return typeof val === 'string' && val.trim() ? val.trim() : undefined;
}
