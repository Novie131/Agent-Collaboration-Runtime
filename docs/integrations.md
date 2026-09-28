# 宿主整合

首版入口是「獨立 CLI＋簡短 Skill／指令片段」。不安裝全域 Hook、不修改使用者設定；是否放入專案由使用者決定。

| 宿主／版本 | 啟動方式 | 工具能否呼叫 CLI | 實際被呼叫的證據 | 狀態 |
| --- | --- | --- | --- | --- |
| Claude Code 2.1.278 CLI／2.1.283 VS Code | 將 `integrations/claude-code/skills/jest-result-view/` 複製到專案 `.claude/skills/` | 可（Bash 工具執行 `npx agent-efficiency test …`） | **尚無**：未跑過真實任務確認 Agent 會選用 Skill | experimental |
| Codex | 將 `integrations/codex/AGENTS.snippet.md` 內容加入專案 AGENTS.md | 未驗證 | 無（本機未安裝） | unsupported |

## Usage 涵蓋範圍（Claude Code transcript）

| 項目 | 是否涵蓋 |
| --- | --- |
| cache 讀／寫 | 是，與未快取 input 互斥 |
| reasoning | 含在 output_tokens，未拆分 |
| 子 Agent | 只含同檔 sidechain；獨立檔案不含 |
| compaction | 呼叫本身的 usage 不在 transcript（缺口） |
| 標題生成、權限 classifier | 不在 transcript（缺口） |

## 原生工具繞過

Claude Code 原生 Read／Grep／Glob 完全不經過本工具；本工具只影響透過 `agent-efficiency test` 執行的 Jest。Agent 仍可直接執行 `npx jest`，此時不會有任何優化，adoption 以 `scripts/run-record-from-transcript.mjs` 從 transcript 統計。

## Skill 的成本

`SKILL.md` 984 bytes、Codex 片段 657 bytes。Skill 描述與內容會進入宿主 context，屬於優化組的額外 Token，必須包含在 T_task 裡（在真實 session 的 usage 中自然反映）。

## 驗證 Skill 是否真的被使用（需付費執行，未自動進行）

1. 在測試專案放入 Skill，開新 session，給一個需要跑 Jest 的任務。
2. 結束後：`node scripts/run-record-from-transcript.mjs <transcript> … > run.json`，檢查 `adoption.wrapper_invocations > 0`。
3. 也可 `analyze --adapter claude-code`，R004 會標出產生 artifact 後很快就 expand 的情形。
