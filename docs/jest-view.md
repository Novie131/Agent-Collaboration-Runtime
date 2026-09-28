# Jest Result View（policy `jest-v1`）

狀態：**experimental**。只在 `--mode optimize --policy jest-v1 --allow-experimental` 時回傳 view。已驗證的 Jest 版本：**29.7.0**（`fixtures/real/jest-29.7.0/`）。其他 major 版本一律回退原始輸出。

## View 一定包含

- cwd（相對顯示）、命令、開始時間、耗時
- Jest 原始 exit code 或 signal（及映射後結束碼）、是否逾時、是否取消、是否執行完整
- suites／tests 的 failed／skipped／todo／passed 計數；有快照時的 snapshot 計數
- **每一個**失敗 suite 的 Jest 格式化訊息原文（含 `●` 測試名稱、expected／received diff、code frame、stack）
- 若某失敗測試不在格式化訊息中，附上它的原始 `failureMessages`
- 所有 skipped／todo 測試名稱與被略過的 suite
- 無法驗證為 reporter 重複的 stderr 行（逐字，並附上所屬 suite header 作為脈絡）
- 全部 stdout（逐字）
- 省略項目清單與 `expand` 指令

## View 省略（可用 expand 取回）

| `--part` | 內容 |
| --- | --- |
| `passed` | 通過測試的名稱與耗時 |
| `stderr --raw` | 已驗證為重複的 reporter 行與失敗區塊（原始 stderr 全文） |
| `failures` | 原始 `failureMessages`（未經 Jest 過濾的 stack）與 `failureDetails` |
| `result` | 完整 JSON 結果 |
| `stdout --raw` | 原始 stdout |

這是 **selective view**，不是語意無損：例如通過測試的名稱、每個測試的耗時，對某些任務可能仍有用。

## 完整性 gate（任一失敗即回傳原始輸出，並記錄原因）

| 檢查 | fallback 原因 |
| --- | --- |
| Jest 版本在已驗證清單 | `unverified_jest_version` |
| JSON 存在、可解析、只有已知欄位 | `result_json_missing` / `result_json_invalid` / `result_schema_mismatch` / `result_unknown_fields` / `run_exec_error` |
| 未逾時、未取消、未被 signal 終止、有 exit code | `timed_out` / `cancelled` / `terminated_by_signal` / `exit_status_missing` / `spawn_error` |
| 計數自洽、未中斷、每個失敗 suite 有訊息 | `result_inconsistent` / `run_interrupted` |
| exit code 與 JSON `success` 一致（例如 exit 非零但 JSON 全綠 → 不回傳通過摘要） | `exit_result_contradiction` |
| stdout／stderr 完整寫入、為合法 UTF-8 | `capture_write_error` / `output_not_utf8` |
| artifact 檔案 hash 與捕捉到的 bytes 一致 | `artifact_hash_mismatch` / `artifact_write_error` |
| view bytes 小於原始 stdout+stderr（只是防膨脹，不是 Token 成效證明） | `view_not_smaller` |

## 拒絕的 Jest 參數

`--watch`、`--watchAll`、`--json`、`--outputFile`、`--testResultsProcessor`、`--listTests`、`--showConfig`、`--init`、`--clearCache`、`--help/-h`、`--version/-v`（含 kebab-case 與 `--no-` 形式；`--no-watch` 允許）。其餘參數原樣以 argv 傳給 Jest。Wrapper 不更改測試集合、timeout、retries、coverage 或 worker 設定；`--timeout-ms` 是 wrapper 的整體時間上限，基線與優化組必須使用相同值。
