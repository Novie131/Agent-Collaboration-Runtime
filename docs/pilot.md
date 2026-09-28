# Pilot 實驗清單（M5）

目的：找問題，不是證明品質。建議 10 個任務、每組每任務至少 3 次。**付費執行需使用者指定任務與預算；本工具不會自動呼叫 Agent 或 API。**

## 事前（看結果之前固定）

- [ ] 任務分成 train／holdout；每個任務寫好 `TaskManifest`（需求、base commit、必要測試含邊界與回歸、適用檢查或 N/A、相容性、安全、禁止變更、rubric 維度、外部 verifier）。
- [ ] 外部 verifier：Agent 無法修改；在乾淨 checkout 上執行必要測試並輸出 `verifier-result.json`（模板：`examples/pilot/verifier-result.template.json`）。
- [ ] 固定設定（`examples/pilot/settings.template.json`）：宿主版本、模型、reasoning effort、權限模式、時限、停止條件、硬體、依賴 digest。三組完全相同。
- [ ] `stats_plan`：α=0.05 單側、`tango_score_paired`、`task_cluster_bootstrap_percentile`、iterations、seed、`min_tasks_for_token_ci`、`min_token_gain`（暫定 0.05）。寫入後不再修改。
- [ ] 安全／完整性 fixtures：`corepack pnpm test` 全數通過，記錄 digest。

## 組別

| 組 | 做法 |
| --- | --- |
| A0 | 宿主原本流程（`npx jest`），不放 Skill |
| A1 | Skill＋`agent-efficiency test --mode passthrough` |
| B | Skill＋`agent-efficiency test --mode optimize --policy jest-v1 --allow-experimental` |

A0 vs B 為使用者端到端效益（包含 Skill 本身的 Token）；A1 vs B 只看 renderer 的效果。一次只測一個策略變因。

## 每次執行

- [ ] 從相同乾淨工作區開始；隔離 session、記憶、artifact 目錄。
- [ ] 記錄 prompt cache 冷／暖，並交錯或隨機安排組別順序。
- [ ] 包含失敗與逾時的成本。
- [ ] 產生 run record：
  ```bash
  node scripts/run-record-from-transcript.mjs <transcript.jsonl> --run-id <task>-<group>-<rep> \
    --task <task> --group <A0|A1|B> --rep <n> --settings settings.json --verifier verifier-result.json \
    [--policy jest-v1 --policy-hash <agent-efficiency policies --json 的 hash>] --cache-state <cold|warm> > runs/<id>.json
  ```

## 彙整

把 tasks 與 runs 放入實驗 manifest（參考 `examples/experiment.synthetic.json`），執行：

```bash
node dist/cli.js compare experiment.json --out-dir comparison
```

## 已知阻礙

Claude Code transcript 缺少標題生成、權限 classifier、compaction 的 usage，所以 T_task 會是 incomplete，Token gate 會是 inconclusive。正式 pilot 前需要找到並驗證完整 usage 來源（例如 headless 模式輸出的整體 usage；**未驗證**），或改用能提供完整 usage 的 canonical 紀錄。

## 結果處理

- 品質退步 → `regressed`：保留結果、停用候選策略。
- Token 無改善 → `no_gain`：保留結論，換方向，不粉飾。
- 樣本不足或資料不完整 → `inconclusive`：只能稱「可實驗使用」。
