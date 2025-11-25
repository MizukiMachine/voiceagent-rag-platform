### Issue Title
Viewer/Dashboard に clientTag ごとの食事ログ全件を表示できるようにする

### 背景・問題点
- 栄養エージェント（Mary）が `mealLogAppend` と `todayMeals` を組み合わせてプロフィールを更新すると、`mealLogs` が最新1件だけに丸め込まれ、Viewer (`/viewer/{clientTag}`) と Nutritionダッシュボード (`/nutrition/{clientTag}`) でも直近1件しか表示されない。
- ダッシュボード側から保存しても同じ問題が再現し、ユーザーが手動で食事ログを積み上げることができない。
- `var/nutrition/profiles.json` を見ると clientTag ごとに複数件の `mealLogs` が欲しいのに、実際には 1 件しか残っていないケースが多数発生している。
- 現状のビューは「直近の食事記録(最大3件)」など件数制限付きで実装されており、バックエンドの保持件数に依存せず UI 側でも全件表示できるようにする必要がある。

### やりたいこと
1. **プロフィール保存ロジックの修正**
   - `services/nutrition/profileService.ts` で `todayMeals` を PATCH しても過去の `mealLogs` が削除されないようにする（`mealLogAppend`/`todayMealsAppend` でのみ追加され、他のフィールド更新では維持される構造にする）。
   - Mary が画像経由でログ追加するパス（`update_user_profile`）でも履歴が確実に積み上がるよう回帰テストを追加。
2. **Viewer / Dashboard の表示改善**
   - `/viewer/{clientTag}` と `/nutrition/{clientTag}` の双方で、clientTag に紐づく `mealLogs` を全件（スクロール可能なリストなど）表示する。
   - 「今日の食事ログ」や「直近○件」といった限定表示をやめ、永続化されている内容をそのまま確認できる状態にする。
3. **操作手段の整備**
   - ダッシュボードから手動で食事ログを追記できる UI を提供し、保存後に即座に全件表示へ反映されることを確認できるようにする。

### 期待する成果
- 任意の clientTag で複数件の食事ログを追加しても1件に潰れない。
- Viewer / ダッシュボード双方で、当日の追加分を含めた全履歴を確認できる。
- ユニットテストや e2e（必要なら）で、`mealLogs` が維持され UI で全件表示されることを検証できる。
