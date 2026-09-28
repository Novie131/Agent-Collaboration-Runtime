# 測試與實測結果

執行日期：2026-09-28。環境：macOS（darwin arm64）、Node v24.20.0、pnpm 12.6.0。

## 工程驗證

| 項目 | 結果 |
| --- | --- |
| `pnpm typecheck` | 通過 |
| `pnpm build` | 通過 |
| `pnpm test` | 10 個檔案、152 個測試全數通過 |
| README 命令 | analyze／test（shadow、optimize）／expand／compare／policies／adapters／prune 皆以預期結束碼完成 |
| 真實 Jest CLI | 以 Jest 29.7.0 實際執行通過與失敗測試；exit code 0／1 原樣傳回；`expand --raw` 與保存的 stderr 逐 byte 相同；回退時不重跑（測試中以呼叫計數驗證） |

測試涵蓋規格 §16 各類：通過／失敗／多種狀態／特殊輸出（stderr、console、Unicode、多行 diff）／不明格式（未驗證版本、壞 JSON、缺欄位、未知欄位）／矛盾（exit 非零但 JSON 全綠）／回退不重跑／執行異常（timeout→124、signal→128+n、取消、磁碟滿→125）／artifact（hash 不符、刪除、越界 id、symlink）／讀取版本（改檔、新需求、compaction、子 Agent 不合併）／計量（cache 互斥、reasoning 不重算、父子去重、累計 reset）／不完整資料（不補 0）／安全（transcript 內命令不執行、Markdown 轉義、遮罩）／品質 gate（Token 降但正確率退步→regressed）／成效 gate（bytes 降但 T_task 升→不會 validated）／統計邊界（小樣本全成功不給零寬區間）。

「實際接入（宿主真的呼叫 wrapper）」**未驗證**：需付費 Agent 執行。

## 真實 Jest 29.7.0 輸出：bytes（非 Token）

以 `scripts/capture-jest-fixtures.mjs` 經 shadow 模式擷取（合成測試碼、真實 Jest 輸出）。「會使用 view」表示 optimize 模式下完整性 gate 全部通過。

| 情境 | 原始 stdout+stderr | view | 會使用 view |
| --- | ---: | ---: | --- |
| 120 個 suite，1 個失敗 | 7,420 B | 1,413 B | 是（−81%） |
| 同上，`--verbose` | 15,224 B | 1,431 B | 是（−91%） |
| 2 個 suite 全通過 | 378 B | 641 B | 否，回退 |
| 同上，`--verbose` | 2,239 B | 660 B | 是（−71%） |
| 5 個失敗（含 diff、Unicode、stack） | 2,957 B | 3,412 B | 否，回退 |
| 同上，`--verbose` | 4,321 B | 3,431 B | 是（−21%） |
| skipped／todo／snapshot（單檔，自動 verbose） | 607 B | 979 B | 否，回退 |
| console.log／warn／error | 1,982 B | 1,721 B | 是（−13%） |
| 測試檔無法執行（缺模組） | 876 B | 1,265 B | 否，回退 |
| 以上全部（7 個 suite） | 4,716 B | 5,561 B | 否，回退 |

解讀：

- 只有在 suite 很多或 verbose 輸出時，bytes 才明顯減少；多數小型輸出回退為原始內容，**沒有節省也沒有損失**。
- 失敗資訊在 view 中與 Jest 原始格式逐字相同；view 本身的標頭與「Omitted」段落約 400–500 B，是小型輸出變大的主因。
- 這些是**輸出 bytes**，不是 provider Token，更不是整體任務 T_task。實際效益需經 pilot（docs/pilot.md）驗證。

## Claude Code adapter（真實 transcript）

以本專案開發 session（VS Code extension 2.1.283）驗證：strict 模式解析無略過行、所有 tool_result 均配對、每個 request 的 usage 欄位完整；但因存在標題生成與權限 classifier 呼叫（無 usage），T_task 正確標示為 incomplete。

## 結論

- **工程完成度**：原型已完成（M0–M3；M4 部分）。
- **效益驗證狀態**：未驗證。合成實驗範例的結論為 `inconclusive`，且標示為合成資料。
