"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { useSessionSpectator } from "@/app/hooks/useSessionSpectator";

const BADGE_LABELS = {
  develop: "開発ブラウザ",
  glasses01: "ARグラス #1",
  glasses02: "ARグラス #2",
} as const;

type ValidTag = keyof typeof BADGE_LABELS;
const VALID_TAGS = new Set<ValidTag>(Object.keys(BADGE_LABELS) as ValidTag[]);

export function ClientViewer({ clientTag }: { clientTag: string }) {
  const searchParams = useSearchParams();
  const tag = clientTag;
  const isValid = VALID_TAGS.has(tag as ValidTag);
  const spectator = useSessionSpectator();
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  const [resetNoticeTone, setResetNoticeTone] = useState<"success" | "error">("success");

  const resolvedBffKey = useMemo(() => {
    const qp = searchParams?.get("bffKey");
    if (qp) return qp;
    if (typeof window !== "undefined" && (window as any).__MCPC_BFF_KEY) {
      return (window as any).__MCPC_BFF_KEY as string;
    }
    return process.env.NEXT_PUBLIC_BFF_KEY;
  }, [searchParams]);

  const baseUrl = searchParams?.get("baseUrl") ?? undefined;
  const canResetMemory = Boolean(spectator.scenarioKey);

  useEffect(() => {
    if (!isValid) return;
    void spectator.connect({
      clientTag: tag,
      bffKey: resolvedBffKey ?? undefined,
      baseUrl,
    });
  }, [isValid, resolvedBffKey, tag, baseUrl]);

  const handleResetMemory = async () => {
    setResetNotice(null);
    const result = await spectator.resetMemory();
    if (result.ok) {
      setResetNoticeTone("success");
      setResetNotice("記憶をリセットし、最新セッションを購読し直しました。");
    } else {
      setResetNoticeTone("error");
      setResetNotice(result.message ?? "記憶リセットに失敗しました。");
    }
  };

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
            <button
              onClick={handleResetMemory}
              disabled={!canResetMemory || spectator.isResettingMemory}
              className="rounded-lg bg-rose-500/90 text-slate-50 text-xs font-semibold px-3 py-2 shadow-lg shadow-rose-500/30 disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-95 transition"
            >
              {spectator.isResettingMemory ? "リセット中…" : "記憶をリセット"}
            </button>
            <div className="text-xs px-3 py-1 rounded-full bg-slate-800/60 border border-white/10">
              {spectator.status}
            </div>
          </div>
        </div>
        <p className="text-xs text-slate-200/80">
          記憶リセットは「直前の会話コンテキスト」を消して再接続します。現在のセッションも再購読されます。
        </p>

        {resetNotice && (
          <div
            className={`rounded-lg px-3 py-2 border ${
              resetNoticeTone === "success"
                ? "border-emerald-400/40 bg-emerald-900/30 text-emerald-50 text-xs"
                : "border-amber-400/50 bg-amber-900/30 text-amber-50 text-xs"
            }`}
          >
            {resetNotice}
          </div>
        )}

        <p className="text-3xl font-bold text-amber-100">
          現在のシナリオ: {spectator.scenarioKey ?? "解決中…"}
        </p>

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
