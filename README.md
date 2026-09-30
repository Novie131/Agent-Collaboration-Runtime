# ACR — Agent Collaboration Runtime（暫名）

讓 **ChatGPT Web**（架構師／審查者）與 **Claude Code**（CLI／VS Code，實作者）透過一個本機 Hub 協作。兩邊不共享對話，只交換**任務、結果、證據、決策與 artifact**，並盡量少傳 context。

> **Agents do not share conversations. They share evidence, tasks, decisions, and only the context necessary for the next action.**

> **目前狀態：MVP 開發中，效益未驗證。**
> Hub（任務、狀態機、驗證、review、決策、兩個 MCP endpoint、指標）已實作，並以真實 git 與 Jest 跑過端到端流程；
> ChatGPT Web 經由 Secure MCP Tunnel 連線**尚未實測**；Claude Code plugin 尚未打包（目前用 `acr connect claude` 手動設定）。
> **不宣稱任何省 Token 百分比**，見 [SPEC §30](Document/plan/agent-collaboration-runtime-SPEC.md) 與 [可行性評估](Document/plan/feasibility.md)。

## 它怎麼運作

```text
你 ──► ChatGPT Web ──(remote MCP, 127.0.0.1:8787, 只經 OpenAI Secure MCP Tunnel 對外)──┐
                                                                                  ACR Hub ──► repo（唯讀 git）
你 ──► Claude Code ───(local MCP, 127.0.0.1:8788, bearer token，永不對外)──────────┘
```

- **由你推動每一步**：ChatGPT 無法被喚醒，Claude Code 是 pull 模式。Hub 在每個回應附上 `next` 建議，並拒絕超出限制的請求。
- **Hub 驗證 Claude 的說法**：用 git 比對實際變更檔案（排除 claim 前就已修改的檔案）、用 `run_tests` artifact 核對測試數字、依實際變更檔案重新評估風險。
- **ChatGPT 只讀得到該任務範圍**：任務 scope 與實際變更的檔案、artifact；其餘要透過 `request_context` 請 Claude 提供。機密檔案一律拒絕，內容遮罩。
- **量測分開報告**：Claude 端為實測（transcript，下限），ChatGPT 端為工具 I/O 估算（下限），兩者不相加。

## 安裝與建置

需要 Node.js ≥ 24 與 pnpm（可用 `corepack pnpm`）、git。

```bash
corepack pnpm install
corepack pnpm build        # 依相依順序建置所有套件
corepack pnpm typecheck
corepack pnpm test
corepack pnpm check:core   # core 套件必須離線（SPEC §9.3）
```

以下 `acr` 代表 `node <repo>/apps/cli/dist/cli.js`。

## 快速開始

```bash
cd your-project
acr init                 # 建立 .agent-runtime/config.json（可提交）；資料放在 OS app-data 目錄
acr start                # 啟動 Hub（兩個 endpoint，都只綁 127.0.0.1）

acr connect claude       # 印出 `claude mcp add ...`（user scope，token 不進 repo）與量測用 hook
acr connect chatgpt      # 說明如何只把 remote endpoint 經 Secure MCP Tunnel 暴露給 ChatGPT
```

在 ChatGPT：「建立一個 ACR 任務：……」→ 在 Claude Code：「Take the next ACR task.」→ 回到 ChatGPT：「Check T-1.」

沒有 ChatGPT 也能試：`acr task create --file task.json` 以開發者身分建立任務。

### Hub 指令

| 指令 | 作用 |
| --- | --- |
| `init` / `start` / `status` | 註冊 workspace、啟動 Hub、查看開放中的任務與下一步 |
| `task list \| show <id> [--events] \| create \| accept [--force] \| cancel \| resolve --to` | 開發者檢視與控制任務；`--force` 覆寫 guard 會記錄為人工覆寫 |
| `context show <id> --for claude\|chatgpt` | 看某一方此刻會收到什麼（不會 claim） |
| `decisions list` | 決策紀錄 |
| `metrics <id>` | Claude 實測 vs ChatGPT 估算（不相加） |
| `connect claude\|chatgpt` | 連線設定說明 |
| `hook` | Claude Code PostToolUse hook：記錄哪個 session 處理哪個任務（供量測） |

### MCP 工具

- **remote（ChatGPT）**：`create_task`、`list_tasks`、`get_task`、`get_result`、`get_diff`、`read_file`、`get_artifact`、`request_context`、`submit_review`、`record_decision`、`get_decisions`、`accept_task`、`cancel_task`、`get_metrics`。讀取工具標 `readOnlyHint`。
- **local（Claude Code）**：`get_task`、`submit_result`、`respond_review`、`fulfill_context`、`report_blocked`、`get_decisions`、`run_tests`、`expand`。

## 沿用的舊工具（原 Agent Efficiency）

| 指令 | 作用 |
| --- | --- |
| `analyze` | 讀取明確指定的 session 紀錄，找出候選浪費（R001–R004）並統計 usage。只提醒，不阻擋。 |
| `test` | 執行專案本機 Jest 一次，保存原始 artifact；依模式回傳原始輸出或通過完整性檢查的結構化 view。 |
| `expand` | 從 artifact 取回被省略的內容；只讀檔，永不重跑。 |
| `compare` | 離線成對比較：品質 gate 與整體 Token 比較（Tango、cluster bootstrap）。 |
| `policies` / `adapters` / `prune` | 策略狀態、輸入格式支援程度、清理舊 run 目錄。 |

`test` 的結束碼：Jest 自身的 exit code；signal n → 128+n；逾時 124；wrapper 錯誤 125。

## 文件

- [Document/plan/agent-collaboration-runtime-SPEC.md](Document/plan/agent-collaboration-runtime-SPEC.md) — 規格（v2）
- [Document/plan/feasibility.md](Document/plan/feasibility.md) — 可行性評估
- [docs/adr/](docs/adr/) — 架構決策
- [CONTEXT.md](CONTEXT.md) — 術語
- [docs/](docs/) — 舊工具的文件（jest-view、adapters、privacy、pilot、limitations…）

## 授權

MIT，見 [LICENSE](LICENSE)。相依套件：commander、zod、@modelcontextprotocol/sdk（MIT）；開發用 typescript（Apache-2.0）、vitest、@types/node（MIT）。
