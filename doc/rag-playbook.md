# RAG Playbook (Drive → Gemini File Search)

## 1. 情報分類ポリシー
| 区分 | 説明 | 保存先 | 備考 |
| --- | --- | --- | --- |
| Public | 公開可能な資料、パンフレット | Drive: `/RAG/Public` | そのまま File Search 同期 |
| Internal | 社内限定手順やメモ | Drive: `/RAG/Internal` | Editor 権限は最小限。File Search へは `file-search-admin` のみで同期 |
| Restricted | 個人情報/顧客情報を含む | ローカル暗号化ストレージ | File Search 非同期。要マスキングのうえ添付 |

## 2. アクセス権の原則
- Drive 側はグループ `rag-editors@` と `rag-viewers@` を用いてロールベース管理
- File Search へのクエリは BFF のサーバーサイドのみ許可し、UI からの直接呼び出しは禁止
- Service Account キーは Secret Manager or `.secrets/` (git ignore) に格納し、Rotate を30日運用

## 3. 容量 & ファイルサイズ
- File Search ストアは 1GB 単位でスケール、初期は `1GB × 3` を確保
- Drive 側は 1ファイル 100MB 超を禁止。超過しそうな場合は下記スクリプトで分割

```bash
split -b 95m huge.pdf huge_chunk_
# 生成された chunk を個別にアップロードし File Search 側で同一タグを付与
```

## 4. 同期手順（Google Drive → File Search）
1. Drive 側で対象フォルダに `RAG_SYNC_READY` ラベルを付与
2. Git 管理外の `.secrets/file-search-admin.json` を使い、`gcloud beta discoveryengine data-stores documents ingest-from-drive` を実行
3. 同期成功後に `doc/baseline/rag-sync-<date>.log` を残し、`RAG_SYNC_READY` ラベルを `RAG_SYNC_DONE` に変更

## 5. インシデント対処
- ファイル削除は Drive 側で行い、File Search には `gcloud ... documents batch-delete` を併用
- 機密誤同期時は 30分以内に `rag-managers@` ML へ連絡し、監査ログ (Logging sink) でアクセス主体を洗い出す

## 6. 今回の確認事項 (2025-11-13)
- 情報分類ルール/フォルダ構成を上記とすることをプロジェクト内で合意
- 100MB 超資料向けの分割手順を記載
- Drive アクセス権ルール（グループベース）を README の大型改修サマリに紐付け

> File Search ストア作成と Drive 同期は `doc/GCP_FILE_SEARCH_SETUP.md` の手順で実施します。実運用ログは `doc/baseline/` 配下に追記してください。

