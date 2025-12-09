# エージェントデモ

OpenAI Realtime API + Agents SDK デモです。  
シナリオ（エージェント集合）の切り替え、イベントログ、モデレーション結果などをブラウザ上で追跡できます。

## TL;DR
- Realtime API と @openai/agents@0.3.0 を使ったマルチエージェントのPoC実装
- Next.js 15 + React 19 + TypeScript で構築し、UIは日本語化済み
- 5つのデモシナリオを試せる（Graffity / Schedule Coordinator* / Patricia / Mark / Takuboku）
- Simple / Retail / Chat Supervisor などの旧シナリオは無効化済みで、UI からは Graffity・Schedule Coordinator (Kate)・Patricia・Mark・Takuboku の5種類のみ選択できます。
- *Schedule Coordinator は Google Calendar MCP を使う kate シナリオのことです。
- デフォルト応対は Graffity シナリオ（短く丁寧な日本語アシスタント）
- Google カレンダー MCP と連携した「Schedule Coordinator」シナリオを追加し、複数人の空き時間比較と予定登録まで実行可能
- 2端末のセッション進捗を読み取り専用で追える観覧ダッシュボード `/viewer` を追加（SSE経由で文字起こし・シナリオ配信をリアルタイム反映）

## 大型改修サマリ (2025-11)
### 目的
- Realtime機能をBFF(API)化してクライアント依存を分離
- 画像入力と外部APIブリッジを統一インターフェイスで扱い、今後のMCPプラグイン拡張に備える
- CoreデータはローカルDB/ベクトルストアで保持しつつ、RAGにはGemini File Search + Drive同期を採用

### 非目的
- SOC2/ISMAP等の本番セキュリティ監査、WAF、OAuth再設計は本タスクでは未着手
- 画像ウイルススキャンや高度モデレーションはインターフェイスのみ準備し後続タスクで実装

### 完了条件
1. `doc/IMPLEMENTATION_PLAN.md` に沿ってBFF/API設計→実装→UI切り替えが完了
2. 画像入力・外部API・MCP連携がテスト駆動で検証され、CI（lint/test/e2e）がグリーン
3. `doc/GCP_FILE_SEARCH_SETUP.md`/`doc/rag-playbook.md` の手順に従い、Gemini File Search + Drive同期が有効化され容量/権限管理を満たす

### 実装パス概要
1. **0. 事前準備**: 環境変数整備、lint/testベースライン記録、1ページ提案書の追加、GCP/RAG運用要件の整理
2. **1. API化**: SessionManager抽出、Next.js API Route化、zodバリデーションと共通エラーハンドラの導入
3. **2. 画像入力**: `/api/session/{id}/event` に画像・メタデータを追加し、ストレージへのオフロードHookを設計
4. **3. MCP対応**: ServiceManager配下にMCPプラグインを登録し、シナリオごとのオン/オフ切替を実装
5. **4. File Search統合**: Google Drive分類/容量設計に沿って同期し、RAGハンドラから File Search を叩く

## MCP接続基盤（2025-11追加）
- 人が読みやすいYAML設定に対応しました。`config/mcp.servers.yaml`（例: `config/mcp.servers.yaml.example` をコピー）にサーバー一覧を記述すると、自動で接続・ライフサイクル管理します。
- もし別パスを使いたい場合は `MCP_SERVERS_FILE` でファイルパスを指定できます。ファイルが見つからない場合のフォールバックとしてのみ、従来の `.env` `MCP_SERVERS`（JSON配列）を参照します。
- シナリオ側の要求は `scenarioMcpBindings`（`src/app/agentConfigs/index.ts`）で宣言し、`requiredMcpServers` に列挙した id（config の id と一致）が初期化され、対応するシナリオのエージェントへだけ紐付けられます。
- `ServiceManager.shutdownAll()` を呼ぶと接続中のMCPサーバーもまとめてクリーンアップされるため、テストやサーバー再起動時の後処理が容易です。

詳細は `doc/IMPLEMENTATION_PLAN.md` を参照してください。

### Google カレンダー MCP（シナリオ: ケイト）
- サーバー設定例は `config/mcp.servers.yaml.example` の `google-calendar` エントリを参照。`config/mcp.servers.yaml` にコピーして利用します。
- デフォルト構成では Cloud Build が `external/google-calendar-mcp` を専用イメージにまとめ、`google-calendar-mcp` という Cloud Run サービスとして streamable_http でホストします。メインサービスは `GOOGLE_CALENDAR_MCP_URL` と `GOOGLE_CALENDAR_MCP_SHARED_SECRET` を通じて HTTPS 経由で接続します。
- ローカル開発のみ STDIO で直接起動したい場合は `config/mcp.servers.yaml.example` の `google-calendar-local` を参考にし、`./scripts/run-google-calendar-mcp.sh` を使って同梱サブモジュールを立ち上げてください（OAuth JSON / トークンパスの扱いは従来通り）。
- シナリオキーは `kate`。`src/app/agentConfigs/index.ts` の `scenarioMcpBindings` で `requiredMcpServers: ['google-calendar']` を指定済み。
- ブラウザで初回のみ Google 同意ポップアップを許可するとトークンが保存され、以降は予定取得・作成・変更・削除が可能です。
- 初回遅延を避けたい場合は `.env` の `MCP_EAGER_SERVERS=google-calendar` を設定しておくと、BFF起動時にバックグラウンドで MCP 接続をウォームアップします（失敗しても起動は継続）。
- 詳細な手順とトラブルシュートは `doc/google-calendar-mcp.md` を参照してください。

## プロジェクト概要
- Web クライアントは `src/app` にあり、Transcript／イベントログ／ツールバーを個別コンポーネントとして分離
- エージェント定義は `src/app/agentConfigs/` 以下にまとまっており、SDK へそのまま渡せる JSON 互換構造

### 観覧専用ダッシュボード（/viewer）
- クライアントタグ（例: `glasses01`, `glasses02`）を入力すると、最新セッションに自動追従して SSE を購読し、リアルタイム文字起こしと `voice_control` イベントを読み取り専用で表示します。手入力のセッションIDを併用することも可能です。
- BFF Key を一度入力すれば双方で共有されます。Cloud Run 等別オリジンをモニタしたい場合は Base URL を指定してください。
- 共有用リンクボタンで `tagA/tagB/sessionA/sessionB/bffKey/baseUrl` をクエリに含めたURLをコピーできます（キーの扱いには十分注意してください）。
- 開発用ブラウザ: `/viewer/develop`（タグ `develop` を自動追従）
- グラス用プリセット: `/viewer/glasses01`, `/viewer/glasses02`（それぞれ単一タグを自動追従）。従来の2ペイン版 `/viewer` も継続提供（初期タグは glasses01 / glasses02）。

## 手順
1.  `npm install` 
2.  `.env` に`OPENAI_API_KEY` など必要な環境変数を設定
3.  `npm run dev`
4. ブラウザで [http://localhost:3000](http://localhost:3000) 
- 右上の「シナリオ」「エージェント」プルダウンで構成を切り替え可能 (`?agentConfig=` クエリにも対応)

## Cloud Run デプロイ
- BFF/API とフロントを同一の Next.js コンテナとして Cloud Run にホストできます。
- 手順と必要な環境変数は `doc/deploy-cloud-run.md` を参照してください。`scripts/deploy-cloud-run.sh` 実行で、`gcr.io/ai-conversation-engine` へビルド→Cloud Run（例: `asia-northeast1`）へデプロイできます。
- CI/CD で自動デプロイしたい場合は `cloudbuild.yaml` を使って Cloud Build トリガーを作成してください（同ドキュメントに手順を記載）。

## Cloud Run ログの確認
- リアルタイムで追う:
  ```bash
  gcloud run services logs read ai-conversation-engine \
    --region=asia-northeast1 \
    --stream \
    --limit=200
  ```
- エラーだけを見る:
  ```bash
  gcloud run services logs read ai-conversation-engine \
    --region=asia-northeast1 \
    --severity=ERROR \
    --limit=100
  ```
- ブラウザ未捕捉エラーや `logClientEvent` で送ったイベントは `/api/client-logs` 経由で Cloud Logging に出ます。ログビューアでは `component="client_log"` でフィルタすると見やすいです。
- Cloud Console から見る場合: 「Logging → ログ エクスプローラ」でリソースを「Cloud Run サービス」、サービス名を `ai-conversation-engine` に指定してください。

## BFF Session API
- `/api/session` でセッションを作成し、レスポンスに含まれる `streamUrl` を `EventSource` で購読すると、RealtimeイベントをSSEで受信できます。
- クライアントは `x-bff-key` ヘッダ（`NEXT_PUBLIC_BFF_KEY`）を付与して各APIを呼び出します。サーバー側は `BFF_SERVICE_SHARED_SECRET` と突き合わせます。
- `/api/session/{id}/event` は `kind` ベースの汎用コマンド（`input_text` / `input_audio` / `input_image` / `control` など）でRealtimeにイベントを転送します。
- `/api/session/{id}/stream` は 25 秒ごとの `heartbeat` とセッション状態イベント（history/guardrail/agent_handoff等）を SSE で配信します。
- 詳細なパラメータとエラールールは `doc/api-spec.md` を参照してください。`curl -H "x-bff-key: $NEXT_PUBLIC_BFF_KEY" -X POST http://localhost:3000/api/session -d '{"agentSetKey":"graffity"}'` でローカル動作確認できます。

## 画像入力（UI / API）
- UI: 左ペイン上部の「カメラ連携」と「画像アップロード」を選べます。
  - **カメラ連携**: カメラ権限を許可するとプレビューが表示されます。`解像度`（例: 640x360）、`fps`（0.5–5）、`JPEG品質` を選び、
    - 「1枚撮影して送信」: その場で1枚を送信し LLM 応答を1回返します。
    - 「低fps連投を開始」: 1–2fpsなど低レートで連投します。デフォルトでは **初回のみ応答** を返し、以降はサイレントで送信します（レート/コスト抑制のため）。必要なら「毎フレーム応答」チェックか「次のフレームだけ応答」ボタンで一時的に応答を有効化できます。
  - **画像アップロード**: JPEG/PNG/WebP/PDF（最大8MB、`.env.sample`で変更可）をドラッグ&ドロップまたはファイル選択し、任意のキャプションを付けて送信できます。送信後はTranscriptにサムネイルを表示し、PDFはラベル表示します。
- API: `/api/session/{id}/event` に `multipart/form-data` で `file` と任意の `text`/`triggerResponse` を送信します。レスポンスに `imageMetadata`（mimeType/size/storagePath）が返ります。JSONで `input_image` を送る既存形式も継続対応。
- 環境変数: `IMAGE_UPLOAD_TARGET`=`local|gcs`（既定: local）、`IMAGE_UPLOAD_DIR`（local時の保存先）、`IMAGE_UPLOAD_GCS_BUCKET` / `IMAGE_UPLOAD_GCS_PREFIX`（gcs時のバケット／任意プレフィックス）、`IMAGE_UPLOAD_MAX_BYTES`、`IMAGE_UPLOAD_ALLOWED_MIME_TYPES`。本番は GCS 保存＋ライフサイクルルール（7日削除）を推奨。ローカル開発は従来通りディスク保存で動作します。
- セーフガード: MIME/サイズバリデーションのみ実施。高度モデレーション/ウイルススキャンは後続タスクで差し込み可能な構造にしてあります。

## クライアント実装メモ（BFF利用時に必要な対応）
本BFFサーバーは「どのデバイスからでも Realtime API + Agents SDK を **外部APIとして安定稼働させる**」ことを目的にしています。ただしBFFは「セッション管理・APIキー隠蔽・イベント中継」を担うレイヤーであり、**クライアント側にも下記の実装／工夫が必要**です。READMEを参照しながらAPIリファレンスを書く場合も、以下を前提としてください。

| 目的 | ブラウザ実装サンプル | 他デバイスで必要なこと |
| --- | --- | --- |
| 音声入力（Upload） | `useMicrophoneStream` が `MediaDevices.getUserMedia` → `ScriptProcessorNode` で `24kHz mono PCM` を生成し、`sendAudioChunk` で `/api/session/{id}/event` へ `input_audio` を送信 | 端末固有のマイクAPIでPCMを取得し、同じ `input_audio` イベントを組み立てる。Push-to-Talk 切替時は `input_audio_buffer.clear/commit` を忘れずに送る |
| 割り込み（Barge-in）検知 | `SpeechActivityDetector` + `useMicrophoneStream` でユーザー音声を検知し、`interrupt()` を呼ぶ前に `PcmAudioPlayer.stop()` でローカル再生を停止 | 端末側でも「音声エネルギー検知 → `control: { action: 'interrupt' }` 送信 → ローカル再生停止」の3ステップを用意する |
| 音声再生（Playback） | `PcmAudioPlayer` が `transport_event` の `response.output_audio.delta` をキューイング。`mute` / `interrupt` 時は `stop()` を呼んで即停止 | デバイス固有のオーディオプレイヤーで同様にキュー管理し、任意タイミングで停止できるよう抽象化する |
| セッション維持と再接続 | `useRealtimeSession` が SSE (`/api/session/{id}/stream`) を EventSource で購読し、`status` や `heartbeat` を監視。`x-bff-key` もここで付与 | どのクライアントでも SSE/WS を購読し、`DISCONNECTED` 時の再接続ハンドリングと `x-bff-key` 付与を実装する |
| ログとメトリクス | `useEvent().logClientEvent` から `barge_in_detected` などを送信し、BFFの `terminallog.log` に残す | 同じイベント名でログを送れば、BFF側の監査や運用ツールをそのまま流用できる |

実装そのものはデバイスごとに書き直す必要がありますが、参照すべきAPI・制御フロー・ログ粒度はこの表に沿って共通化できます。

### 音声シナリオ／エージェント切り替え時の注意
- BFFは音声ツール（`switchScenario` / `switchAgent`）の結果を `voice_control` SSEイベントとして配信します。**クライアント側でこのイベントを購読・解釈しない限り、実際の切り替えは発生しません。**
- 受け取ったイベントに応じて、以下を自前で実装してください。
  1. `{"action":"switchScenario","scenarioKey":"..."}` を受信 → UI上のシナリオ表示を更新し、新しい `agentConfig` を指定してセッションを張り直す（URL書き換えやAPIパラメータ更新など、端末に合った再接続方法でOK）。
  2. `{"action":"switchAgent","agentName":"..."}` を受信 → 同じシナリオ内で root agent を変更し、必要であればセッションを再接続（またはデバイス固有の方法でハンドオフ指示を送信）。
  3. 切断〜再接続中のUX（プログレス表示・音声での案内）や、Push-to-Talk状態の復旧なども端末ごとに設計する。
- サーバー側でシナリオを勝手に差し替えるAPIは存在しないため、**「イベントをトリガーに、クライアントが主体的にセッションを乗り換える」**という前提で実装してください。READMEをAPIリファレンスとして使う際も、この分業モデルを前提とします。


## 言語・仕様しているモデルの説明
- すべてのエージェントは、日本語で挨拶・案内・フィラーを行うようプロンプトを統一しています。ユーザーが他言語を希望した場合のみ一時的に切り替わります。
- 背後で使用しているモデルは以下の通りです。
 - `gpt-realtime` : 現場エージェント（graffity のみ稼働）
  - `gpt-4o-transcribe` : 音声入力のリアルタイム文字起こし
- `gpt-5-mini` : ガードレール／モデレーション
  - `gpt-5` : スーパーバイザーおよび返品可否判定など高リスク判断

## Creative Parallel Lab（開発者向け）
- ルート: [http://localhost:3000/creative-lab](http://localhost:3000/creative-lab)
- 映画評論家／文学評論家／コピーライターをプルダウンで切り替え、テキスト入力だけで単独 vs 並列の差分を比較できます。
- 単独レーン: 選択ロールのシステムプロンプトで gpt-5-mini を1回実行。Latency/Token情報をカード表示。
- 並列レーン: **MoA + Multi-Judge + Aggregation** 方式。4候補を完全並列生成 → 3審判が独立に採点 → 平均スコアとタイブレーク（短さ→レイテンシ→生成順）で勝者/Runner-upを決定。勝者テキストを基本採用しつつ、スコア差が小さく Runner-up が高得点だった場合のみ1行追加マージを行います。
- 審査サマリ・決定理由・平均スコア表・審判別スコアをUIに表示し、`terminallog.log` にもJSONログを残すため、比較実験や振り返りが容易です。
## デモ用ガード: アシスタント発話中の音声入力抑止

デモ環境ではバージインを避けるため、アシスタントが音声回答中に入ってくる `input_audio` をサーバ側で破棄するガードを入れています。

- 環境変数 `HOTWORD_SWITCH_DELAY_MS` でホットワード検知音が届くようシナリオ切替前に待機（デフォルト 200ms）。
- `BARGE_IN_ENABLED=false` かつアシスタント発話検知中は `input_audio` を無視します。
- 発話検知は Realtime の `response.output_audio.*` イベントを捕捉し、一定時間（デフォルト 1.2s）無音でリセットします。

デモ時にバージインを許可したい場合は `BARGE_IN_ENABLED=true` に変更してください。
