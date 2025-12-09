# Google Cloud / Gemini File Search 準備メモ (2025-11-13)

## ゴール
1. 対象 Google Cloud プロジェクトで Gemini File Search API と Drive コネクタを有効化する  
2. `file-search-admin` サービスアカウントと最小限の IAM ロールを払い出す  
3. 監査ログと File Search ストア（容量1GB単位）を初期化し、Drive 側の情報分類ルールを明文化する

## 事前条件
- プロジェクトID（例: `mcpc-coordinator-dev`）と課金アカウント
- CLI 実行環境: Google Cloud CLI 470+ / Python3.9-3.13
- 実行者は `roles/owner` または API/Drive/IAM をカバーする権限一式

> **NOTE:** 現在リポジトリ環境に入っている gcloud は `six` / `oauth2client` が欠損しており起動できません。  
> `gcloud --version` 実行時に `ModuleNotFoundError: No module named 'six'` が発生するため、`google-cloud-cli` の再インストール or `pip install six oauth2client` での修復が必要です。  
> 再インストール後に `gcloud init` → `gcloud auth login` を実行してください。

## 推奨コマンド
```bash
export CLOUDSDK_CORE_PROJECT=${GCP_PROJECT_ID}
export CLOUDSDK_PYTHON=$(which python3) # 3.11系を想定

# 1. 必要なAPIを有効化
gcloud services enable \
  file.googleapis.com \
  generativelanguage.googleapis.com \
  drive.googleapis.com \
  iam.googleapis.com \
  cloudresourcemanager.googleapis.com

# 2. サービスアカウントと鍵
gcloud iam service-accounts create file-search-admin \
  --display-name="File Search Admin"

gcloud projects add-iam-policy-binding ${GCP_PROJECT_ID} \
  --member="serviceAccount:file-search-admin@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/file.searchAdmin"

gcloud projects add-iam-policy-binding ${GCP_PROJECT_ID} \
  --member="serviceAccount:file-search-admin@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/drive.admin"

gcloud iam service-accounts keys create ./secrets/file-search-admin.json \
  --iam-account="file-search-admin@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

# 3. File Search ストア
gcloud beta discoveryengine data-stores create file-search-store \
  --collection-id="default_collection" \
  --location="global" \
  --project=${GCP_PROJECT_ID}

# 4. Drive データソース同期
gcloud beta discoveryengine data-stores site-search add-target-site file-search-store \
  --target-site-uri-prefix="https://drive.google.com/drive/folders/${RAG_SOURCE_DRIVE_ID}"

# 5. IAM 監査ログ
gcloud logging sinks create file-search-audit \
  storage.googleapis.com/${AUDIT_BUCKET} \
  --log-filter='resource.type="file.googleapis.com/DataStore"'
```

## サービスアカウント権限
| ロール | 用途 |
| --- | --- |
| `roles/file.searchAdmin` | File Search ストア作成・クエリ管理 |
| `roles/drive.admin` | Drive とのデータコネクタ同期 |
| `roles/iam.serviceAccountKeyAdmin` (一時) | サービスアカウント鍵作成時のみ |

## 運用チェックリスト
1. `gcloud info --run-diagnostics` が成功すること  
2. `gcloud beta discoveryengine data-stores list` でストアが確認できること  
3. `./secrets/file-search-admin.json` が `.gitignore` 登録済みであること  
4. IAM 監査ログが `logging sinks describe file-search-audit` で確認できること  
5. File Search ストア容量 (初期 1GB) のアラート閾値を 80% に設定（Cloud Monitoring）

## 次のアクション
- プロジェクトID、DriveフォルダID、監査バケット名を確定し、`.env.sample` の該当値を置き換える  
- CLI の破損を修復して上記コマンドを実行 → 実行ログを `doc/baseline/gcp-setup-<date>.log` として保存する  
- File Search ストア > Drive 同期結果を `doc/rag-playbook.md` の運用ルールに追記する

