- ベースURL : [https://ai-conversation-engine-335443821829.asia-northeast1.run.app](https://ai-conversation-engine-335443821829.asia-northeast1.run.app/)

## ■ はじめに全体のサマリー

- これはなにか
    - Cloud Runにデプロイしたサーバー経由でOpenAIのリアルタイム機能を使うためのクライアント実装者向けドキュメント
    - 役割は「①セッションを作る」「②入力（文字・音声・画像・制御）を送る」「③サーバーからの実況（SSE）を受け取る」
    - これを決められた形で呼ぶだけで済むようにすること
    - クライアントは秘密鍵を持たず、サーバーが代わりにOpenAIとやり取りします
- どういう思考で準備したか
    - 安全に : APIキーをクライアントに渡さずBFFが代理接続する。x-bff-key で簡易認証
    - 多デバイス共通化 : ブラウザでもモバイルでもARグラスでも、「作成・送信・SSE購読」さえ実装すれば動くように
    - リアルタイム前提 : SSEでこまめにイベントを投げる（heartbeatやstatus）ことで切断検知や再接続をやりやすくする
- どう役立つか
    - まずセッションを作る : `POST /api/session` を叩くと「この会話のパイプ」と「SSE購読URL」がもらえる
    - イベントを送る : 文字なら `input_text`、音声なら `input_audio`、画像はファイル送信。ここへ送るだけ
    - サーバーからの実況を受け取る : EventSource で streamUrl を購読すると、回答の断片や音声データ、エラー通知、シナリオ切替指示(voice_control)がリアルタイムで飛んでくる。受け取ったら自分のUI/プレイヤーで再生・表示
    - 終わるとき : `DELETE /api/session/{id}` を呼べばセッションを閉じられる
    - もし止まったら : heartbeatが途絶えたり session_error が来たら、もう一度 `POST /api/session` で新しく作り直すのが基本の復旧イメージ

<aside>

- **POST /api/session** : セッション作成 → 「Create Session API」
- **POST /api/session/{id}/event** : 入力・制御イベント送信 → 「Send Session Event API」
- **GET /api/session/{id}/stream** : SSE ストリーム購読 → 「Session Stream API」
- **DELETE /api/session/{id}** : セッション終了 → 「Delete Session API」
</aside>

---

## ■ セッション関連 API

- セッションの作成：`POST /api/session`
    - 新しい Realtime セッションを作成し、購読URL・TTLなど初期情報を返す
    - 認証: `x-bff-key: <BFF_SERVICE_SHARED_SECRET>`（クエリ `?bffKey=` でも可だがヘッダー推奨）
    - ローカル確認例
        
        ```bash
        curl -H "x-bff-key: $NEXT_PUBLIC_BFF_KEY" \\
             -X POST <http://localhost:3000/api/session> \\
             -d '{"agentSetKey":"graffity"}'
        
        ```
        
    - **レスポンス例（実装に準拠）**
        
        ```json
        {
          "sessionId": "sess_abc123",
          "streamUrl": "/api/session/sess_abc123/stream",
          "expiresAt": "2025-11-16T01:23:45.000Z",
          "heartbeatIntervalMs": 25000,
          "allowedModalities": ["audio","text"],
          "textOutputEnabled": true,
          "memoryKey": "graffity",
          "capabilityWarnings": [],
          "agentSet": { "key": "graffity", "primary": "Graffity" }
        }
        
        ```
        
    - `memoryKey` は BFF が永続メモリを参照する際に利用している実キーです（エージェントセット単位・ユーザー単位など実装依存）。クライアントから `/api/memory` を呼ぶときはこの値を指定すると確実です。
    - BFF側では `BFF_SERVICE_SHARED_SECRET` と突き合わせて認証します

---

- セッションの終了：`DELETE /api/session/{id}`
    - 明示終了用エンドポイント。`?reason=manual_close` など理由を付けるとログに残る
    - 正常時は `{ "ok": true }`。存在しないIDは 404 / 期限切れは 410 の可能性

---

- 永続メモリの明示リセット：`DELETE /api/memory`
    - 目的: セッションをまたいで保持されるサーバー側の永続メモリ（会話履歴）をクリアする
    - 認証: `x-bff-key` 必須（`POST /api/session` と同じ）
    - リクエストボディ (JSON)
        - `agentSetKey` (必須): どのシナリオのメモリを消すか
        - `memoryKey` (任意): 個別のキーを指定したい場合のみ。未指定なら clientTag → metadata.memoryKey → agentSetKey の順で決定
        - `clientTag` (任意): 指定するとそのタグをメモリキーとして扱う。旧フォーマット `agentSetKey:clientTag` も同時に消去する
    - レスポンス例
        ```json
        {
          "ok": true,
          "memoryKey": "kate"   // 実際に削除されたキー
        }
        ```
    - cURL例
        ```bash
        curl -X DELETE http://localhost:3000/api/memory \
          -H "x-bff-key: $NEXT_PUBLIC_BFF_KEY" \
          -H "Content-Type: application/json" \
          -d '{"agentSetKey":"kate","clientTag":"glasses01"}'
        ```
    - 補足
        - サーバーの永続メモリは `PERSISTENT_MEMORY_ENABLED=true` のとき有効（未設定時はデフォルトで有効）
        - リセットしても現在のセッションはそのまま継続します。必要に応じて `POST /api/session` で張り直してください

---

- ビューア用セッション追従 API（ARグラス実装者はここだけ守ればOK）
    - 目的: `/viewer/glasses01` などのモニター画面が「最新セッション」に自動追従すること。
    - やること（最短手順）
        - **毎回のセッション作成で `clientTag` を必ず入れる**  
          例)
          ```bash
          curl -X POST http://localhost:3000/api/session \
            -H "Content-Type: application/json" \
            -H "x-bff-key: $NEXT_PUBLIC_BFF_KEY" \
            -d '{ "agentSetKey": "graffity", "clientTag": "glasses01" }'
          ```
          これだけで viewer は自動で最新セッションを解決し、`/api/session/{id}/stream` を購読します。
        - ※ `clientTag` を付け忘れた場合のみ、補救手段として `POST /api/viewer/register` を1回呼ぶ
            - 例 `{ "clientTag": "glasses01", "sessionId": "sess_xxx", "scenarioKey": "graffity" }`
            - セッションが無ければ 404
    - 認証: `x-bff-key` 必須（ヘッダー推奨）
    - 運用ルール
        - タグは固定運用: `glasses01 / glasses02 / develop`
        - BFF Key: `NEXT_PUBLIC_BFF_KEY` があればクエリ不要。無い場合のみ `?bffKey=...`
        - viewer は閲覧専用（ただし「記憶リセット」だけ可 / `DELETE /api/memory` を内部で呼ぶ）

---

- イベント送信：`POST /api/session/{id}/event`
    - 任意の入力イベントをセッションに流し込む
    - `kind` によって扱う内容が変わります（`input_text` / `input_audio` / `input_image` / `control` / `event`）
    - 主なフィールド
        - テキスト: `kind: "input_text"`, `text`, `triggerResponse`(省略時true), `metadata`
        - 音声: `kind: "input_audio"`, `audio`(base64 PCM16), `commit`(省略時true), `response`(省略時true)
        - 画像: `kind: "input_image"`, `data`(base64), `mimeType`, `text`(キャプション), `triggerResponse`
        - 制御: `kind: "control"`, `action: interrupt | mute | push_to_talk_start | push_to_talk_stop`
        - 生イベント: `kind: "event"`, `event`(Realtimeイベントをそのまま中継)

    **音声まわりの推奨設定（ホットワード必須運用を崩さないため）**
    - 接続直後に1回だけ `session.update` を送る：
        ```json
        {
          "kind": "event",
          "event": {
            "type": "session.update",
            "session": {
              "type": "realtime",
              "audio": {
                "input": {
                  "turn_detection": {
                    "type": "server_vad",
                    "create_response": false
                  }
                }
              }
            }
          }
        }
        ```
        - 意味: サーバーVADで話し終わりを検知しても、自動で `response.create` を出さない。ホットワードでマッチしたときだけサーバー側ロジックが応答を開始できる。
    - `input_audio` は原則 `response:false`（または未指定=デフォルトfalse推奨）で送る。
        - `response:true` を付けると、そのチャンクをコミットした瞬間に応答が走り、ホットワード無視で1回だけ返答する事象が起きやすい。
        - PTTなど「明示的にこのターンで即レスしたい」場面だけ、クライアント側で `response.create` を送るか `response:true` を使う。

---

- SSE ストリーム：`GET /api/session/{id}/stream`
    - セッションの状態と各種イベントを SSE で受け取る
    - 代表的なイベント
        - `ready`（購読直後）
        - `status`（接続状態）
        - `heartbeat`（25 秒ごと）
        - `history_added` / `history_updated`
        - `agent_handoff` / `agent_tool_start` / `agent_tool_end`
        - `guardrail_tripped`
        - `transport_event`（音声/テキストのdeltaなど生Realtimeイベント。`textOutputEnabled=false` なら文字系は抑止）
        - `session_error`（上流エラーの要約）
        - `voice_control`（音声シナリオ・エージェント切替指示）
    
    クライアントは EventSource などで購読し、切断時の再接続処理も実装してください
    

---

## ■ 画像入力

- API で画像送信 : `/api/session/{id}/event` に対して `multipart/form-data` で `file`（または `image`）を送る
    - 送信可能項目
        - `file`（画像本体）
        - `text`（任意のキャプション）
        - `triggerResponse`（応答の強制トリガー、省略時は true）
        
        **レスポンス例（抜粋）**
        
        ```json
        {
          "imageMetadata": {
            "mimeType": "image/jpeg",
            "size": 123456,
            "storagePath": "/local/tmp/abcd.jpg",
            "originalName": "sample.jpg"
          }
        }
        ```
        

---

- 画像アップロード関連の環境変数
    
    
| 変数名 | 説明 |
| --- | --- |
| `IMAGE_UPLOAD_TARGET` | `local` or `gcs`（既定: `local`） |
| `IMAGE_UPLOAD_DIR` | `local` 時の保存先ディレクトリ |
| `IMAGE_UPLOAD_GCS_BUCKET` | `gcs` 時に必須のバケット名 |
| `IMAGE_UPLOAD_GCS_PREFIX` | `gcs` 時の任意プレフィックス（末尾スラなし推奨） |
| `IMAGE_UPLOAD_MAX_BYTES` | 受け付ける最大サイズ |
| `IMAGE_UPLOAD_ALLOWED_MIME_TYPES` | 許可 MIME（カンマ区切り） |

※ 本番は `IMAGE_UPLOAD_TARGET=gcs` 推奨。バケットのライフサイクルルールで7日後削除を設定してください。

- 補足
    - キャプション未指定時は `[Image] <ファイル名 or MIME>` を自動付与
    - `triggerResponse` を false にすると画像だけ蓄積し応答を抑止

---

## ■ クライアント実装時のポイント

BFF はOpenAIのフレームワークをつかっていることにより、いろいろなことの実現が可能になっていますが、

「セッション管理・キー隠蔽・イベント中継」に特化しているため、

クライアント側にもいくつか実装すべき役割があります。

（これに関しては、OpenAIのフレームワークの特性上現状仕方ないと思ってください）

以下に、ブラウザ版の参考実装と、他デバイスで必要な対応をまとめます。

- 実装項目一覧
    
    
    | 目的 | ブラウザ例（既存実装） | 他デバイスで必要なこと |
    | --- | --- | --- |
    | 音声入力（Upload） | `useMicrophoneStream` が `24kHz mono PCM` を生成し `sendAudioChunk` で送信 | マイクAPIから PCM を取得し、同等の `input_audio` イベントを組み立てる |
    | 割り込み（Barge-in）検知 | `SpeechActivityDetector` でユーザー音声を検知し、`interrupt()` → 再生停止 | 音声エネルギー検知 → `control: interrupt` 送信 → ローカル再生停止 |
    | 音声再生（Playback） | `PcmAudioPlayer` が `response.output_audio.delta` をキュー再生 | デバイス固有のプレイヤーで同様のキュー制御と停止処理を実装 |
    | セッション維持と再接続 | EventSource で SSE を購読し、`heartbeat` や `status` を監視 | SSE/WS の再接続処理と `x-bff-key` 付与を実装 |
    | ログ・メトリクス | `logClientEvent` で `barge_in_detected` などを送信 | 同じイベント名で送れば BFF 側のログ管理が共通化可能 |

---

## ■ ⚠️音声シナリオ／エージェント切り替えの注意点

### ホットワード必須化
- すべての音声指示は必ず「Hey + シナリオ名」で始める必要があります。ホットワードが検出されない場合、その音声は破棄され、所定時間後にセッションが終了します。
- ホットワード検出後、BFF が音声トランスクリプトからホットワード部分を除いたテキストを再送し、その内容で Realtime API へ応答を生成させます。
- 異なるシナリオ名のホットワードが見つかった場合は `voice_control` SSE イベントに `initialCommand` が含まれ、クライアント側でシナリオ切替と初回コマンド送信を自動実行します。


音声操作でAI集合をごそっと切り替える事によって シナリオ（機能）の切り替えやエージェントの切り替えを実現しています

BFF は音声系のツール実行結果を **`voice_control`** イベント として SSE で通知します
クライアント側がこのイベントを処理しない限り、実際の切り替えは発生しません

- 受け取ったときの基本フロー
1. **シナリオ切替**
    - 例：`{"action":"switchScenario","scenarioKey":"..."}`
    - 新しい `agentConfig` を指定して**セッションを張り直す←せつぞくしなおす！**
    （URL 書き換え・再接続など、方法は端末に合わせてOK）
2. **エージェント切替**
    - 例：`{"action":"switchAgent","agentName":"..."}`
    - root agent を更新
    - 必要ならセッション再接続、あるいはデバイス固有のハンドオフ処理

🚧：サーバーから強制的にシナリオを差し替える API は現状存在しません

「通知を受けて、クライアントが主体的に乗り換える」という前提で設計してください

今はセッションを張るAPIしかないですが、確立して用意した方がいいAPIがある場合は検討後今後実装していきたいです

---
