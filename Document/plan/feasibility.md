# ACR 可行性評估

| | |
|---|---|
| 日期 | 2026-09-30（平台事實查證於 2026-09-29） |
| 對象 | [agent-collaboration-runtime-SPEC.md](agent-collaboration-runtime-SPEC.md) v2 |
| 結論 | **技術上可以串起來；風險在價值主張與量測，不在串接。** MVP 可做，但不能在 MVP 宣稱任何省 Token 百分比。 |

## 1. 總表

| 元件 | 可行性 | 關鍵依據 | SPEC 對應 |
|---|---|---|---|
| Claude Code 串接（pull 模式） | **高** | 使用者自己的 session 透過 MCP 呼叫 local endpoint；訂閱與 API key 都能用；CLI 與 VS Code 都支援 MCP | §25.2、ADR-0005 |
| Claude Code 串接（SDK dispatch） | **高**（僅限 API key） | Agent SDK 提供 `canUseTool`、abort、`maxBudgetUsd`、完整 usage；但第三方產品不得使用 claude.ai 登入 | §25.3 |
| ChatGPT → Hub | **中高** | 可以透過 Developer mode 搭配 Secure MCP Tunnel（只往外連、限 org）連進來。限制：需要付費方案；寫入工具每次都要使用者確認；Developer mode 目前是 beta 還是 GA 仍未確認 | §26、§27、ADR-0004 |
| Hub 自主調度 | **不可行**（ChatGPT 端） | ChatGPT 只在使用者發起的回合內呼叫工具，無法被外部喚醒；因此改成由開發者推動，Hub 只提供建議並在必要時拒絕 | §2.2、ADR-0003 |
| Token Governor | **部分可行** | MVP 只能設硬上限並拒絕超限請求；預算上限要等到 SDK 階段，而且只能管到 Claude 端 | §18 |
| Context Broker 省 Token | **可行，但槓桿與原稿不同** | 交接 payload 本來就小。真正的槓桿是：回給 ChatGPT 的工具結果（每個回合都會重讀）、Claude 重複探索、Claude 自己的測試輸出 | §12.1、§19 |
| Context Cache（不重送已看過的內容） | **目前不可行** | Hub 看不到 ChatGPT 對話裡還留著什麼（使用者可能開新對話，或對話已被壓縮） | §19.4（延後） |
| Claude 端 Token 量測 | **中** | 可以從 transcript 取得逐次請求的 usage。但互動式 session 缺少標題生成、權限 classifier、compaction 的用量，所以 MVP 的數字只是**下限** | §29.1 |
| ChatGPT 端 Token 量測 | **只能估算** | 個人方案看不到每段對話的 Token；只能估算工具 I/O 的累積量，而且這也是下限 | §29.2、ADR-0006 |
| 可重現 Benchmark | **MVP 不可行，phase 2 可行** | ChatGPT Web 無法自動化。Tier 1 需要用 OpenAI API 模型代替 ChatGPT，並使用 Agent SDK | §30、ADR-0007 |
| 跨平台 | **高** | Claude Code 原生支援 Windows；`node:sqlite` 不需原生編譯。`tunnel-client` 的跨平台支援**尚未查證** | §5、§34 |
| 重用舊模組 | **高** | artifacts、Jest view、integrity gate、統計 gate、redaction、transcript parser 都已實作並有測試 | §10、ADR-0001 |

## 2. 原稿 SPEC 中不成立或需要修正的假設

1. **「Hub 決定誰行動」**：ChatGPT 無法被喚醒，Claude 在 MVP 是 pull 模式，所以實際上是**開發者推動**。已改寫為「信箱 + 守門員」。
2. **「Baseline = full-context handoff」**：這個 baseline 注定會省很多，數字（82%、67.9%）沒有說服力。已改成「人工複製貼上流程」。
3. **「省下的是交接 context」**：task YAML 只有幾百 Token。真正的成本在於 ChatGPT 對話會反覆重讀工具結果。
4. **「每任務各跑一次 baseline／optimized、只比 pass/fail」**：模型本身有隨機性，這樣得不出可信的結論。已改用舊有的成對統計 gate。
5. **「量測 Token 節省」**：ChatGPT 端看不到 Token，只能估算；Claude 端在 MVP 只能取得下限。兩者分開報告，不相加。
6. **「Context Cache：兩邊都看過就不重送」**：沒有可靠訊號可以判斷，已延後。
7. **「Challenge Protocol 獨立存在」**：與 review comment 重疊，已合併。
8. **Node 22+**：`node:sqlite` 在 22 上仍是實驗性；最低版本改為 24。

## 3. 主要風險與對策

| 風險 | 影響 | 可能性 | 對策 |
|---|---|---|---|
| 最終證明**沒有省 Token**（例如 view 反而變大、多出來的 expand 呼叫抵消節省） | 價值主張失敗 | 中 | 舊的 Jest 實測已發現小型輸出時 view 比原始輸出大，所以保留「view 必須比原始小」的 gate；以 Tier 1 的 `no_gain` 結論如實回報，不美化 |
| ChatGPT 每次寫入都要確認，操作太繁瑣 | 使用體驗差，開發者可能乾脆回到複製貼上 | 中高 | 盡量減少寫入工具數量；讀取工具一律標 `readOnlyHint`；Tier 2 pilot 記錄確認次數 |
| Developer mode 或 Tunnel 政策變動（beta、方案限制、權限） | ChatGPT 端無法連線 | 中 | core 不綁定 transport；保留桌面 app stdio 作為備案；phase 3 開工前重新查證 |
| 對 Claude 的安全控制在 pull 模式下只能事後檢查 | Claude 可能越界修改 | 中 | 事後用 git 檢查範圍並回報；提供建議的權限設定；SDK 階段改用 `canUseTool` 強制執行 |
| 互動式 transcript 的 usage 不完整 | MVP 的 Claude 端數字偏低 | 已確定 | 標示為下限；完整數據以 SDK/headless 為準 |
| Transcript 格式隨 Claude Code 版本改變 | 量測失效 | 中 | 沿用 adapter 的版本清單與真實 fixture；遇到未知格式標為 incomplete，不猜測 |
| 單人開發、範圍太大 | 做不完 | 中 | MVP 已裁剪（§35），phase 0 先完成搬遷；每個 phase 都有明確的完成條件 |
| `node:sqlite` 在 Node 24 上仍是實驗性 | 行為可能改變 | 低 | 以 storage 介面隔離，可換成 `better-sqlite3` |

## 4. 開工前必須先查證的事項

詳見 SPEC §38，依阻擋的 phase 排序：

- **Phase 1**：`node:sqlite` 在 Node 24 上的 WAL 與並行讀取是否可靠。
- **Phase 2**：MCP TypeScript SDK 是否支援 2026-07-28 版規格；Claude Code hook 的輸入（`session_id`、`transcript_path`）；plugin hook 在 VS Code 中是否會觸發。
- **Phase 3**：Developer mode 目前是 beta 還是 GA；`tunnel-client` 是否支援三個平台，以及能否只暴露部分工具。
- **Phase 5**：互動式 session 有沒有辦法取得完整的 usage。

## 5. 結論

- **做得到**：MVP 的 §37 成功條件 1–10 都有已查證的技術路徑，沒有任何一項依賴 UI 自動化或未公開的 API。
- **目前做不到**：自主調度 ChatGPT、精確量測 ChatGPT 端的 Token、MVP 階段的可重現 benchmark。
- **能否成功的關鍵**在於 phase 2 之後的 Tier 1 benchmark 能不能在品質不退步的前提下，證明 Claude 實測加上 ChatGPT 估算的 Token 確實減少。在那之前，對外只說「可以用」，不說「能省多少」。
