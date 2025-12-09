# タイトル案
B2B向けRAGエージェント追加 (Gemini File Search 統合)

## 背景 / ゴール
- 現状シナリオは Graffity のみ。B2B向けに「ドキュメント参照回答」を行うRAGエージェントを追加したい。  
- Retrievalは Gemini File Search を用い、生成は既存の Realtime/Agents パイプを流用。将来は別リトリーバー（Discovery Engine/自前ベクトルDB）へ差し替え可能な設計にする。  
- セキュリティ（鍵はBFFのみ保持、ブラウザから直接呼ばない）と運用（容量/コスト/ラベル運用）を明示し、Playground + 自動テストで検証できる状態を完成させる。

## やること（上から順に実施）
1. **ドキュメント更新**
   - README/API説明のRAG方針を最新化（Gemini File Search 前提、シナリオは Graffity + 新B2B）。  
   - `.env.sample` に FILE_SEARCH_* 系の環境変数を追加（PROJECT_ID, LOCATION, DATA_STORE_ID, SERVING_CONFIG_ID, SA_KEY_PATH など）。
2. **RAG基盤実装**
   - `services/rag/RagRetriever` インターフェイス定義（search(query, topK, filter?)）。  
   - `GeminiFileSearchRetriever` を追加（REST/SDKで File Search を呼ぶ）。  
   - 後で差し替え可能なスタブ/DI（DiscoveryEngine/VectorDB用のプレースホルダ）を用意。  
   - `services/rag/ragService` でスニペット整形・引用メタ付与ロジックを実装。
3. **エージェント統合**
   - B2B RAGシナリオ `b2bRag.ts` を追加し `allAgentSets` に登録（デフォルトはGraffity維持）。  
   - エージェントツール `doc_search` を追加し、ragService を呼ぶよう配線。  
   - プロンプト方針: 事実重視・出典必須・不足時は明示・社外秘NG・回答は要約＋箇条書き＋引用タグ。
4. **テスト/検証**
   - 単体: retriever のHTTPモックでリクエスト組み立て/エラー処理を確認。  
   - 結合: doc_search 経由でプロンプトにスニペットが入ることをスナップショット検証。  
   - Playground: サンプルドキュメントで応答・引用の妥当性を手検証し、`doc/baseline/rag-<date>.log` に残す。  
   - 容量/制限チェック: 100MB/ファイル、ストア推奨20GB以下、インデックス課金$0.15/1M tokens、クエリ無料（2025-12-09時点）。
5. **運用/セキュリティ**
   - サービスアカウント鍵は Secret Manager か `.secrets/`（git ignore）に保持。  
   - BFFでのみ File Search を呼び出し、リクエスト/レスポンスを Cloud Logging に記録（clientTag, scenario, query, hit数）。  
   - 誤同期/削除手順を `doc/rag-playbook.md` に追記。

## 期待する成果
- 新シナリオ「B2BフォローアップRAG」が選択可能になり、問い合わせに対し引用付き回答を返せる。  
- Retrieverを差し替えても最小のコード改修で済むインターフェイスが確立される。  
- コスト/容量/権限/監査手順が明文化され、デモ・社内PoCで安全に利用できる。
