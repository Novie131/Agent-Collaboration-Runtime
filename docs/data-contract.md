# 資料契約

以下皆為本專案自訂格式，不是任何宿主的官方格式。權威定義在 Zod schema：`src/schema/events.ts`、`src/schema/evaluation.ts`、`src/artifacts/manifest.ts`。

## Canonical 事件（JSONL，`schema_version: 2`）

每行一個事件，共同欄位：`id, task_id, run_id, session_id, stream_id, context_epoch?, sequence, timestamp?, source_ref?`（canonical 輸入缺 `source_ref` 時自動填入檔名與行號）。

| `type` | 主要欄位 |
| --- | --- |
| `tool_call` / `tool_result` | `tool_call_id`（配對用，不靠相鄰行猜測）、`category`（read/search/shell/edit/other）、`tool_name`、`path?`、`range?`、`args?`、`content_hash?`、`file_version_hash?`、`exit_code?`、`signal?`、`error_kind?`、`output_bytes?`、`artifact_id?`、`policy_id?`、`expanded_from_artifact_id?` |
| `file_change` | `path`、`tool_call_id?` |
| `user_message` | `text_hash?`、`new_requirement?`（缺省視為新需求） |
| `context_boundary` | `kind`（compaction/clear/resume/other）、`next_epoch?` |
| `usage` | `usage`：完整或不完整的 RequestUsage |
| `session_end` | `reason?` |

規則使用的慣例：搜尋的 `args` 為 `{query, scope, flags}`；shell 為 `{command, cwd}`。

### RequestUsage

- 完整：`request_id, input_uncached, input_cache_read, input_cache_write, output_total, reasoning_included_in_output?, scope:"request", origin:"provider_reported"`。三類 input **互斥**；`output_total` 已含 reasoning，`reasoning_included_in_output` 只供顯示。
- 不完整：`completeness:"incomplete"`、`missing_fields:[…]`，存在的欄位照填，**不補 0**。

`T_task = Σ唯一 request（uncached + cache_read + cache_write + output_total）`，以 `request_id` 跨 stream 去重（子 Agent 請求同時出現在父子紀錄只算一次；數值衝突 → incomplete）。累計計數器由 `cumulativeToDeltas` 轉增量，遞減視為 reset。任何不完整、衝突或 adapter 已知缺漏的呼叫 → `T_task = null`。

## Test run manifest（`<run-dir>/manifest.json`）

`artifact_id`（`ae_<14 位時間>_<8 hex>`）、工具與 runner 版本、模式、policy（id、版本、hash、狀態、renderer 版本）、命令摘要（遮罩）與 wrapper 自加參數、cwd 顯示、起訖時間、timeout、exit（Jest exit code、signal、映射方式、timeout、取消、spawn 錯誤、wrapper 結束碼、wrapper 錯誤）、git snapshot（HEAD、執行前後 dirty；註明不能保證依賴／環境未變）、各檔案 SHA-256 與大小、輸出（回傳 view 或 raw、fallback 原因、gate 結果、raw/view bytes、省略清單）。

## 實驗（`compare` 輸入）

`ExperimentManifest`：`comparisons`（第一個為主要比較，通常 A0 vs B；可加 A1 vs B）、`fixed_settings`（宿主、模型、reasoning effort、Agent 版本、權限、時限、停止條件、硬體、依賴 digest）、`candidate_policy`、`stats_plan`（實驗前固定）、`safety_fixtures`、`tasks[]`、`runs[]`。

- `TaskManifest`：固定需求、base commit、環境、`split`（train/holdout）、驗收（必要測試、適用／N/A 檢查、相容性、安全、禁止變更、rubric 維度）、外部 verifier 描述。
- `RunRecord`：組別、重複序號、settings（必須等於 fixed_settings）、policy、cache 狀態、是否逾時、verifier 結果（pass/fail/invalid、硬性檢查、需求完成、是否跳過／刪除測試、錯誤宣告完成、invalid 類別、rubric）、`regression_confirmed?`、`wrapper_crashed?`、usage（requests＋gaps）、bytes、cost、耗時、adoption。

`invalid` 只在類別為基礎設施（verifier／host／provider）且不是 wrapper crash 時成立；該對 pair 會被一起排除並列出。wrapper crash 一律算失敗。

## 結論狀態

`regressed`（安全 fixtures 失敗、確認的策略回歸、觀測成功率下降或 rubric 下降）→ `inconclusive`（任何 gate 無法評估，或成功率下界 < 0）→ `no_gain`（品質 gate 通過但 Token 證據不足）→ `validated_for_scope`（五個 gate 全通過，僅限該 policy hash、宿主、模型設定與任務集）。
