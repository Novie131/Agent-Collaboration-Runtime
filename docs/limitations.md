# 已知限制

## 效益

- **沒有任何真實 Agent 任務的成對實驗**。不能宣稱省下 Token、費用或維持品質。
- 在真實 Jest 29.7.0 上，**小型或非 verbose 的輸出，view 反而比原始輸出大**（見 test-results.md），完整性 gate 會回退原始輸出，此時沒有節省。明顯的 bytes 減少只出現在 suite 數多或 verbose 輸出時。
- bytes 減少不等於 Token 減少：view 格式、Skill 描述、額外的 expand 呼叫、以及 Agent 因資訊被省略而多做的操作都會影響整體 T_task。

## 量測

- Claude Code transcript 缺少 compaction、標題生成、權限 classifier 的 usage，T_task 會標為 incomplete；存放於其他檔案的子 Agent transcript 不含。
- 成功率的信賴下界只在「每任務一對」時計算（Tango score）；重複執行的 cluster 資料目前沒有可靠方法，只回報觀測值並標為 inconclusive。
- 小樣本且兩組全數成功時，成功率下界必然 < 0 → inconclusive（刻意設計，不製造零寬區間）。
- Token 信賴區間使用任務 cluster 的 percentile bootstrap；任務少於 `min_tasks_for_token_ci` 時不計算。

## Jest view

- 只驗證 Jest 29.7.0（預設 reporter 與 `--verbose`）。其他 major 版本、自訂 reporter、`projects` 設定的 displayName 等只在 gate 允許時才會使用，否則回退。
- stderr 只移除「可證明重複」的行；無法分辨的 console／reporter 內容全部保留，因此可能沒有節省。
- 輸出超過 64 MB 時不產生 view（直接回退，原始輸出由檔案串流回傳）。宿主自身若截斷長輸出，本工具無法控制。
- `Test results written to:` 行只在路徑完全對得上時才移除。

## 診斷規則

- 所有 finding 都是候選，不代表一定是浪費；門檻為初始值，可設定。
- R001 需要內容 hash；部分範圍的 hash 不代表整檔版本。R003 在 Claude Code 中缺 cwd。R004 只證明「展開事件」存在，不證明因果。

## 整合

- Skill 是否真的被 Agent 使用尚未驗證。Codex 不支援。
- 套件名稱為暫名，發布前需確認可用性（本次未查詢 npm registry）。
