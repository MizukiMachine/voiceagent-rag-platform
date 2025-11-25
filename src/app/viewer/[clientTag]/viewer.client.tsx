"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { useSessionSpectator } from "@/app/hooks/useSessionSpectator";

const MEMORY_FEATURE_ENABLED = false;

const BADGE_LABELS = {
  develop: "開発ブラウザ",
  glasses01: "ARグラス #1",
  glasses02: "ARグラス #2",
} as const;

const SCENARIO_LABELS: Record<string, string> = {
  graffity: "Graffityエージェント",
  nutrition: "食事アドバイザー：メアリー",
  kate: "秘書エージェント：ケイト",
  takuboku: "短歌ライター：タクボク",
};

function buildProfileSummary(profile: any): string {
  if (!profile || typeof profile !== "object") return "";
  const parts: string[] = [];
  const sexLabel = profile.sex === "male" ? "男性" : profile.sex === "female" ? "女性" : profile.sex ? "その他" : "";
  const activityLabels: Record<string, string> = {
    low: "活動量:低め",
    moderate: "活動量:ふつう",
    high: "活動量:高め",
  };
  const goalLabels: Record<string, string> = {
    loss: "目標:減量",
    maintain: "目標:維持",
    gain: "目標:増量",
  };

  if (profile.age) parts.push(`年齢${profile.age}歳`);
  if (sexLabel) parts.push(sexLabel);
  if (profile.heightCm) parts.push(`身長${profile.heightCm}cm`);
  if (profile.weightKg) parts.push(`体重${profile.weightKg}kg`);
  if (profile.goalType && goalLabels[profile.goalType]) parts.push(goalLabels[profile.goalType]);
  if (profile.activityLevel && activityLabels[profile.activityLevel]) parts.push(activityLabels[profile.activityLevel]);
  if (profile.avoidFoods) parts.push(`避けたい食品:${profile.avoidFoods}`);
  if (profile.dietStyle) parts.push(`食事スタイル:${profile.dietStyle}`);
  if (profile.todayMeals) parts.push(`今日の食事:${profile.todayMeals}`);
  return parts.join(" / ");
}

function buildMealLogSummary(profile: any): { today: string | null; recent: string | null } {
  const today = typeof profile?.todayMeals === "string" && profile.todayMeals.trim()
    ? profile.todayMeals.trim()
    : null;

  const logs: any[] = Array.isArray(profile?.mealLogs) ? profile.mealLogs : [];
  const recent = logs
    .slice()
    .sort((a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime())
    .slice(-3)
    .map((log) => {
      const ts = log.recordedAt ? new Date(log.recordedAt).toLocaleString() : "";
      const tod = log.timeOfDay ? `[${log.timeOfDay}] ` : "";
      return `${tod}${log.description ?? ""}${ts ? ` (${ts})` : ""}`;
    })
    .join("\n");

  return { today, recent: recent || null };
}

type ValidTag = keyof typeof BADGE_LABELS;
const VALID_TAGS = new Set<ValidTag>(Object.keys(BADGE_LABELS) as ValidTag[]);

export function ClientViewer({ clientTag }: { clientTag: string }) {
  const searchParams = useSearchParams();
  const tag = clientTag;
  const isValid = VALID_TAGS.has(tag as ValidTag);
  const spectator = useSessionSpectator();
  const [profileSummary, setProfileSummary] = useState<string>("読み込み中…");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [mealToday, setMealToday] = useState<string | null>(null);
  const [mealRecent, setMealRecent] = useState<string | null>(null);

  const resolvedBffKey = useMemo(() => {
    const qp = searchParams?.get("bffKey");
    if (qp) return qp;
    if (typeof window !== "undefined" && (window as any).__MCPC_BFF_KEY) {
      return (window as any).__MCPC_BFF_KEY as string;
    }
    return process.env.NEXT_PUBLIC_BFF_KEY;
  }, [searchParams]);

  const baseUrl = searchParams?.get("baseUrl") ?? undefined;
  const userId = searchParams?.get("userId") ?? "demo-user";

  useEffect(() => {
    if (!isValid) return;
    void spectator.connect({
      clientTag: tag,
      bffKey: resolvedBffKey ?? undefined,
      baseUrl,
    });
  }, [isValid, resolvedBffKey, tag, baseUrl]);

  // プロフィールサマリの定期取得（ダッシュボード更新を即時反映）
  useEffect(() => {
    let abort = false;
    const origin = baseUrl?.trim() || (typeof window !== "undefined" ? window.location.origin : "");

    async function fetchProfile() {
      try {
        const url = new URL(`/api/debug/profile`, origin || "http://localhost:3000");
        if (userId) url.searchParams.set("user_id", userId);
        const res = await fetch(url.toString(), { headers: { "Content-Type": "application/json" } });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json = await res.json();
        if (abort) return;
        const summary = buildProfileSummary(json?.profile);
        const mealSummary = buildMealLogSummary(json?.profile);
        setProfileSummary(summary || "未設定が多いため、ダッシュボードで入力してください。");
        setMealToday(mealSummary.today);
        setMealRecent(mealSummary.recent);
        setProfileError(null);
      } catch (error: any) {
        if (abort) return;
        setProfileError("プロフィール取得に失敗しました");
      }
    }

    fetchProfile();
    const timer = setInterval(fetchProfile, 8000);
    return () => {
      abort = true;
      clearInterval(timer);
    };
  }, [baseUrl, userId]);

  const badge = useMemo(
    () => (isValid ? BADGE_LABELS[tag as ValidTag] : tag),
    [isValid, tag],
  );

  if (!isValid) {
    return (
      <main className="min-h-screen bg-slate-950 text-white flex items-center justify-center">
        <div className="p-6 rounded-xl border border-white/10 bg-white/5">
          無効なタグです: {tag}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-amber-900 via-slate-900 to-emerald-950 text-white">
      <div className="max-w-3xl mx-auto px-4 py-10 space-y-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold mt-1">{badge} をモニター</h1>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-xs px-3 py-1 rounded-full bg-slate-800/60 border border-white/10">
              {spectator.status}
            </div>
          </div>
        </div>
        <p className="text-xs text-slate-200/80">
          {MEMORY_FEATURE_ENABLED
            ? "記憶リセットは「直前の会話コンテキスト」を消して再接続します。現在のセッションも再購読されます。"
            : "永続メモリは無効化中のため、リセット操作は行えません。"}
        </p>
        <p className="text-3xl font-bold text-amber-100">
          現在のシナリオ: {SCENARIO_LABELS[spectator.scenarioKey ?? ""] ?? spectator.scenarioKey ?? "解決中…"}
        </p>

        <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur shadow-2xl p-4 space-y-2">
          <p className="text-xs font-semibold text-slate-200">利用プロフィールのサマリ</p>
          {profileError ? (
            <p className="text-xs text-rose-200">{profileError}</p>
          ) : (
            <p className="text-sm text-amber-50 whitespace-pre-wrap leading-relaxed">{profileSummary}</p>
          )}
          <div className="space-y-1 text-sm text-amber-50 whitespace-pre-wrap leading-relaxed">
            {mealToday && <p>今日の食事ログ: {mealToday}</p>}
            {mealRecent ? (
              <p>
                直近の食事記録(最大3件):
                <br />
                {mealRecent}
              </p>
            ) : (
              <p>直近の食事記録がまだありません。</p>
            )}
          </div>
        </div>

        {spectator.lastError && (
          <div className="rounded-lg border border-slate-500/30 bg-slate-800/50 text-slate-100 px-3 py-2 text-xs">
            {spectator.lastError}
          </div>
        )}

        <section className="space-y-3">
          <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur shadow-2xl p-5 space-y-3">
            <div className="text-xs text-slate-300/80">
              現在の sessionId: {spectator.sessionId ?? "解決中…"}
            </div>
            <div className="space-y-2">
              {spectator.transcripts.length === 0 ? (
                <p className="text-sm text-slate-300/80">まだ文字起こしが届いていません。</p>
              ) : (
                spectator.transcripts
                  .slice()
                  .sort((a, b) => a.updatedAt - b.updatedAt)
                  .map((item) => (
                    <div
                      key={item.itemId}
                      className="rounded-lg bg-slate-900/40 border border-slate-700/40 p-3 shadow-md"
                    >
                      <div className="flex items-center justify-between text-xs text-slate-300/70 mb-2">
                        <span className="uppercase tracking-wide flex items-center gap-2">
                          <span className="rounded px-2 py-0.5 bg-slate-800 text-slate-100">
                            {item.role === "user" ? "User" : "Assistant"}
                          </span>
                          {item.status === "STREAMING" ? "Streaming" : "Completed"}
                        </span>
                        <span>{new Date(item.updatedAt).toLocaleTimeString()}</span>
                      </div>
                      <p className="whitespace-pre-wrap leading-relaxed text-slate-50 text-xl md:text-2xl">
                        {item.text || "…"}
                      </p>
                      {item.lastEventType && (
                        <p className="text-[11px] text-sky-200/70 mt-2">event: {item.lastEventType}</p>
                      )}
                    </div>
                  ))
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur shadow-2xl p-4 space-y-3">
            <p className="text-xs font-semibold text-slate-200">シナリオ配信 / 音声制御</p>
            {spectator.directives.length === 0 ? (
              <p className="text-xs text-slate-300/80">まだイベントはありません。</p>
            ) : (
              <ul className="space-y-2 text-xs">
                {spectator.directives.map((directive) => (
                  <li
                    key={directive.id}
                    className="rounded-md bg-gradient-to-r from-emerald-900/30 to-amber-900/30 border border-emerald-700/30 px-3 py-2"
                  >
                    <div className="flex items-center justify-between text-[11px] text-emerald-100/80 mb-1">
                      <span className="font-semibold">{directive.action}</span>
                      <span>{new Date(directive.timestamp).toLocaleTimeString()}</span>
                    </div>
                    <pre className="text-[11px] text-amber-50/90 overflow-x-auto">
                      {JSON.stringify(directive.payload ?? {}, null, 2)}
                    </pre>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
