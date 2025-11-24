## 永続メモリ／記憶リセット機能 見直しメモ（Issue #130）

### 方針
- 直前の会話コンテキストをセッション間で活用することが目的。過去ログの再生は行わない。
- デフォルトで永続メモリを有効化（`PERSISTENT_MEMORY_ENABLED` 未設定時は true）。必要に応じて env で無効化。
- memoryKey 優先順位: 明示指定 > metadata.memoryKey > clientTag > metadata.userId > agentSetKey。
- リプレイは Realtime API 互換ペイロードのみ送信し、metadata など非互換フィールドは除去。
- リプレイ失敗時はスキップしてセッション継続、クライアントへ `session_error` 通知。
- キーは clientTag 単位（旧 `agentSetKey:clientTag` も読み出してマージする）。リセット後は viewer が再接続して空状態から購読する。
- リプレイは最後の assistant 発話までを採用し、未回答のユーザー発話を切り落として自動応答の暴発を防ぐ。
- legacy キーを読み出したら clientTag キーへマージ保存し、旧キーを削除する（再接続ごとの二重リプレイ防止）。

### 実装メモ
- コア: `services/coreData/persistentMemory.ts`
  - `resolveMemoryKey` に clientTag を追加。
  - リプレイイベントは `id` に `pm:` プレフィックスのみで識別、metadata を送らない。
- BFF: `services/api/bff/sessionHost.ts`
  - デフォルト有効化。clientTag をキー解決に反映。
  - リプレイ失敗時に `session_error (memory_replay_failed)` を配信。
  - `pm:` プレフィックスでリプレイ検出し、クライアント転送を抑止。
- API: `DELETE /api/memory`
  - `clientTag` を受け付け、キー解決に利用。
- Viewer UI / Hook
  - リセット説明文を追加。
  - リセット成功時に SSE を張り直し、履歴をクリア。

### テスト観点
- memoryKey 解決（clientTag 優先）とリセット API の挙動。
- リプレイイベントに metadata が含まれないこと、`pm:` ID でフィルタリングされること。
- リプレイ失敗時に `session_error` が通知されてもセッションが継続すること。
