# Agent Efficiency（暫名）

品質優先的 Coding Agent Token 優化工具。目標：**在不降低任務正確率與完成品質的前提下，減少整個 Coding Agent 任務的 Token 使用量。**

本機、離線、無遙測。CLI 的資料處理不呼叫任何模型。

> **目前狀態：原型已完成，效益未驗證。**
> 工程面（診斷、Jest 結構化結果、完整性 gate、artifact、成對比較）已實作並測試；
> 「是否真的減少整個任務 Token 且不降低品質」尚未用真實 Agent 任務驗證。
> 詳見 [docs/test-results.md](docs/test-results.md) 與 [docs/limitations.md](docs/limitations.md)。

## 功能

| 指令 | 作用 |
| --- | --- |
| `analyze` | 讀取**明確指定**的 session 紀錄，找出候選浪費（R001 重複讀取、R002 重複搜尋、R003 環境失敗重試、R004 壓縮後補讀），並統計 usage。只提醒，不阻擋。 |
| `test` | 執行專案本機安裝的 Jest（一次），保存原始 artifact；依模式回傳原始輸出或經完整性檢查的結構化 view。 |
| `expand` | 從 artifact 取回被省略的內容；只讀檔，**永不重跑測試**。 |
| `compare` | 離線讀取已完成的 run 記錄，做成對品質 gate 與整體 Token 比較。 |
| `policies` / `adapters` | 列出策略狀態與輸入格式支援程度（只列實際驗證過的版本）。 |
| `prune` | 列出（預設 dry-run）或刪除舊的 run 目錄。 |

## 安裝與建置

需要 Node.js ≥ 20.11（開發時使用 v24.20.0）與 pnpm（可用 `corepack pnpm`）。

```bash
corepack pnpm install
corepack pnpm build        # 產生 dist/
corepack pnpm typecheck
corepack pnpm test
```

## 使用

```bash
# 1. 診斷一份 session（canonical 格式，或 --adapter claude-code，實驗性）
node dist/cli.js analyze examples/session.canonical.jsonl --adapter canonical --out-dir ./report

# 2. Jest：shadow 模式（預設）— 回傳原始輸出，同時產生候選 view 供比較
node dist/cli.js test --mode shadow --project-root examples/jest-sample --run-dir ./runs/run-001 -- scenarios/pass

# 3. Jest：optimize 模式 — 實驗性策略需明確允許
node dist/cli.js test --mode optimize --policy jest-v1 --allow-experimental \
  --project-root examples/jest-sample --run-dir ./runs/run-002 -- scenarios/fail

# 4. 取回被省略的內容（預設遮罩；--raw 回傳原始 bytes）
node dist/cli.js expand <artifact-id> --run-dir ./runs/run-002 --part failures
node dist/cli.js expand <artifact-id> --run-dir ./runs/run-002 --part stderr --raw

# 5. 成對比較（範例為合成資料）
node dist/cli.js compare examples/experiment.synthetic.json --out-dir ./comparison

node dist/cli.js policies
node dist/cli.js adapters
```

範例 Jest 專案需先安裝：`corepack pnpm --dir examples/jest-sample install --ignore-workspace`。

第 3 步在這個小型範例上會**回退原始輸出**（`fallback: view_not_smaller`），這是預期行為：Jest 預設輸出本來就很精簡時，view 不會更短。要看到實際的 view，執行 `node scripts/capture-jest-fixtures.mjs`（會產生 120 個 suite 的 `scenarios/generated-many`）後再對該目錄執行 optimize，或參考 [examples/reports/jest-view.many-suites.txt](examples/reports/jest-view.many-suites.txt)。

### 模式

| 模式 | 行為 |
| --- | --- |
| `shadow`（預設） | 回傳原始輸出（即時串流），另存候選 view；不宣稱省 Token。 |
| `optimize` | 通過完整性 gate 才回傳 view；否則回傳已捕捉的原始輸出並說明原因，**不重跑**。 |
| `passthrough` | 只保存 artifact，回傳原始輸出。 |

### `test` 的結束碼

Jest 自身的 exit code；被 signal n 終止時為 128+n；wrapper 逾時為 124；wrapper 自身錯誤（設定、拒絕的參數、artifact 寫入失敗）為 125。只有 Jest exit 0 **且** artifact 保存成功才會回 0。

`analyze` / `compare`：0 成功產生報告、1 I/O 錯誤、2 格式不支援或資料無效。「報告產生成功」不代表品質 gate 通過；結論寫在報告內。

## 文件

- [docs/plan.md](docs/plan.md) — 開發計畫與里程碑狀態
- [docs/architecture.md](docs/architecture.md) — 架構與模組
- [docs/data-contract.md](docs/data-contract.md) — 事件、artifact、實驗 manifest 格式
- [docs/jest-view.md](docs/jest-view.md) — Jest view 保留／省略什麼、完整性 gate
- [docs/adapters.md](docs/adapters.md) — 各宿主格式的驗證狀態
- [docs/integrations.md](docs/integrations.md) — Claude Code／Codex 接入方式與驗證狀態
- [docs/pilot.md](docs/pilot.md) — 成對實驗（pilot）執行清單
- [docs/privacy.md](docs/privacy.md) — 隱私、權限與遮罩限制
- [docs/limitations.md](docs/limitations.md) — 已知限制
- [docs/test-results.md](docs/test-results.md) — 測試與實測結果
- [CONTRIBUTING.md](CONTRIBUTING.md)

## 授權

MIT，見 [LICENSE](LICENSE)。相依套件：commander (MIT)、zod (MIT)；開發用 typescript (Apache-2.0)、vitest (MIT)、@types/node (MIT)。
