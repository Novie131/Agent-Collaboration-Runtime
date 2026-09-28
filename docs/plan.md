# 開發計畫與里程碑狀態

依據 `Document/plan/agent-efficiency-spec.md` v0.2。起點：repo 只有規格文件，無 AGENTS.md／CLAUDE.md、無既有程式碼。

## 環境（M0 查核結果）

| 項目 | 版本 |
| --- | --- |
| Node.js | v24.20.0 |
| pnpm | 12.6.0（透過 corepack，未全域安裝） |
| TypeScript / Vitest / Zod / Commander | 5.9.3 / 2.1.9 / 3.25.76 / 12.1.0（lockfile 已提交） |
| Jest（範例專案） | 29.7.0 |
| Claude Code | CLI 2.1.278；VS Code extension transcript 標示 2.1.283 |
| Codex | 未安裝 |

## 里程碑

| 里程碑 | 狀態 | 內容 |
| --- | --- | --- |
| M0 起點與契約 | 完成 | 單一 package、TypeScript strict、Zod schema、合成與真實 fixture 分開放置 |
| M1 量測基礎 | 完成 | canonical JSONL 串流 parser、usage 正規化、R001–R004（各有正例／負例／未知資料案例）、JSON／Markdown 報告 |
| M2 可用優化路徑 | 完成 | Jest runner、artifact、renderer、shadow／optimize／passthrough、expand、完整性 gate；以真實 Jest 29.7.0 跑過通過與失敗測試 |
| M3 比較與品質 gate | 完成 | task／run／experiment manifest、離線 compare、Tango score 成功率下界、任務 cluster bootstrap、結論狀態；範例資料標為合成 |
| M4 真實宿主整合 | 部分 | Claude Code adapter（實驗性）以一份真實去識別化 transcript 驗證；Skill 已寫但**未驗證會被實際呼叫**；Codex 不支援 |
| M5 效益驗證 | 未開始 | 提供 pilot 清單與 run record 產生腳本；需使用者指定任務與預算後才執行付費實驗 |

**工程完成度**：原型可用（M0–M3 完成，M4 部分）。
**效益驗證狀態**：未驗證。沒有任何真實 Agent 任務的成對實驗結果，不可宣稱省下任何百分比。
