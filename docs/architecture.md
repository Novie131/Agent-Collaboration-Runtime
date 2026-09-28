# 架構

單一 package，核心模組與宿主 adapter 分離。CLI 不呼叫模型、不連網、不自動安裝任何東西。

```text
src/
  cli.ts                 Commander 入口；各子命令的 exit code 對應
  schema/                events.ts（canonical 事件，Zod discriminated union）、evaluation.ts（task/run/experiment）
  adapters/              jsonl.ts（串流讀取、單行上限）、canonical.ts、claude-code.ts（實驗性）、index.ts（codex 列為 unsupported）
  observe/               rules.ts（R001–R004）、usage.ts（去重、累計轉增量、T_task）、analyze.ts
  runner/                jest.ts（找本機 Jest、argv spawn、timeout/signal）、jest-args.ts（拒絕清單）、test-command.ts（模式與輸出）
  renderers/             jest-result.ts（JSON 解析＋已知欄位）、stderr-classify.ts（可證明重複的 reporter 行）、jest-view.ts
  artifacts/             manifest.ts、store.ts（建立、hash、安全讀取）、expand.ts、prune.ts
  policies/              registry.ts（jest-v1 定義與 hash）、state.ts（狀態機）、jest-gate.ts（完整性 gate 1–3）
  evaluate/              stats.ts（Tango、bootstrap）、compare.ts（gate 與結論）、run-compare.ts
  privacy/               redact.ts（遮罩、路徑顯示、Markdown 轉義）
  report/                analysis.ts、comparison.ts、write.ts（不覆寫，除非 --overwrite）
integrations/            Claude Code Skill、Codex 指令片段（皆未驗證實際採用）
fixtures/synthetic/      合成樣本
fixtures/real/           真實工具輸出（Jest 29.7.0；Claude Code 2.1.283 去識別化結構）
examples/                jest-sample 專案、canonical session、合成實驗、範例報告、pilot 模板
scripts/                 fixture 擷取、transcript 去識別化、run record 產生
```

## `test` 的資料流

1. 檢查模式／策略狀態 → 拒絕不允許的 Jest 參數 → 找 `<root>/node_modules/jest`（缺少即報錯）→ 建立**新的** run-dir。
2. 以 `spawn(process.execPath, [jest.js, ...args, '--json', '--outputFile=<run-dir>/jest-result.json'], { shell: false })` 執行一次。stdout／stderr 同時寫入檔案（`wx`、0600）並保留記憶體副本（上限 64 MB）。shadow／passthrough 同步即時轉送。
3. 完整性 gate：格式與版本 → 過程完整與 exit／JSON 一致 → 捕捉完整 → artifact hash 核對 → view 比原始小。
4. optimize 且全部通過才輸出 view；否則輸出已捕捉的原始 bytes，附上 fallback 原因。**任何情況都不重跑。**
5. 寫入 manifest（SHA-256、版本、命令摘要、exit/signal、git 狀態、gate 結果、省略清單）。

## 為何 view 能比原始輸出短

`--json --outputFile` 讓 JSON 不佔用 stdout，Jest 預設 reporter 仍照常輸出到 stderr。stderr 只有在以下情況會被移除：

- 與 view 中逐字呈現的 suite 失敗訊息**完全相同**的區塊；
- 經 JSON 驗證的 `PASS/FAIL <path>`、`Test Suites:/Tests:/Snapshots:` 計數行、`Time:`、`Ran all test suites…`、`Test results written to:`；
- verbose 模式中標題與狀態都對得上 JSON 的測試行及其 describe 行。

其他所有行（console 輸出、警告、open handle、未知格式）逐字保留。stdout 全部保留。
