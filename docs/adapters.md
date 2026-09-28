# Adapters：宿主格式驗證狀態

只列出實際測試過的版本與入口。`agent-efficiency adapters` 會輸出相同資訊。

| Adapter | 狀態 | 已驗證 | Fixture |
| --- | --- | --- | --- |
| `canonical` | supported | schema_version 2 | `fixtures/synthetic/`、`examples/session.canonical.jsonl` |
| `claude-code` | **experimental** | 2.1.283（VS Code extension）的一份主執行緒 session | `fixtures/real/claude-code-2.1.283/`（真實結構、內文已換成 hash）、`fixtures/synthetic/claude-code/` |
| `codex` | **unsupported** | 無（本機未安裝 Codex、無樣本） | 無 |

## claude-code

- 來源：`~/.claude/projects/<project>/<session>.jsonl`。格式不是公開穩定 API，版本間可能改變。**必須明確指定路徑**，工具不會自動搜尋歷史紀錄。
- 可觀測工具：`tool_use`／`tool_result`，以 id 配對。Read→read、Grep/Glob→search、Bash→shell、Edit/MultiEdit/Write/NotebookEdit→edit，其餘→other。成功的 edit 產生 `file_change`。
- `agent-efficiency test` 的 Bash 結果若含 artifact id → `artifact_id`／`policy_id`；`agent-efficiency expand <id>` → `expanded_from_artifact_id`（供 R004 與 adoption 統計）。
- Usage：每個 assistant API 回應的 `message.usage`；同一回應跨多行，以 `requestId`（或 `message.id`）去重。實測 2.1.283 的 83 個多行回應，各行 `output_tokens` 相同；仍取最大值以防串流中間值。
- Cache：`input_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens` 視為互斥（Anthropic Messages API 語意）。`cache_creation` 的 5m/1h 細項未另行使用。
- Reasoning：`output_tokens` 已含 thinking，不重算。
- 子 Agent：同檔內 `isSidechain: true` 的項目各自成 stream；存放於其他檔案的子 Agent transcript **不包含**（列為缺口）。
- **無法觀測的模型呼叫**：compaction、session 標題生成（`ai-title` 項目）、權限 classifier（`serverClassifierRequest`）。出現時 T_task 標為 incomplete。實測的真實 session 兩者皆出現，所以 Claude Code transcript 目前**無法給出完整 T_task**。
- 不記錄每次 shell 的 cwd：R003 只能在同一 stream 內依命令分組。

### 重現驗證步驟

```bash
corepack pnpm build
node dist/cli.js analyze <transcript.jsonl> --adapter claude-code --strict --out-dir /tmp/cc-check
# 期望：exit 0、skipped 0、tool_result 皆有配對、usage 不完整原因列於 gaps
node scripts/deidentify-claude-transcript.mjs <transcript.jsonl> fixtures/real/claude-code-<版本>/session.deidentified.jsonl --project-root . --max-lines 400
```

要把狀態提升為 supported，至少需要：含子 Agent 與 compaction 的真實樣本、多個版本，以及找到能涵蓋上述隱藏呼叫的完整 usage 來源（例如 headless 模式的 JSON 結果；**未驗證**）。

## codex

沒有 parser。`src/observe/usage.ts` 已提供累計轉增量（含 reset）與「input 已含 cache」的拆分函式，可作為日後 adapter 的基礎。取得真實樣本前不宣稱支援。
