# Agent Efficiency：品質優先的 Coding Agent Token 優化工具

版本：0.2 · 更新日期：2026-09-28 · 類型：產品需求與實作規格

> 給 Claude：本文件完整取代 v0.1 的開發優先序，可獨立使用。請閱讀全篇再實作。核心交付必須包含可實際使用的優化路徑，不能只完成診斷報告就宣告產品完成。名稱為暫名，發布前查核可用性。

## 1. 唯一核心目標

**在不降低任務正確率與完成品質的前提下，減少整個 Coding Agent 任務的 Token 使用量。**

優先序固定為：

1. 保持任務正確性、安全要求與必要驗證。
2. 保持完成品質及需求覆蓋。
3. 減少整體任務 Token。
4. 再比較費用、耗時與使用體驗。

不得以降低模型等級、調低 reasoning effort、縮短必要思考、刪除必要測試、提早宣告完成或限制使用者需求來達成省 Token。

「不影響思考」是產品目標，不是可以直接觀測的模型內部保證。可驗證的是模型／推理設定不變，並且在指定任務集上正確率與品質沒有觀測到退步。有限測試不能證明所有未來任務都不退步；證據不足時必須標記 inconclusive，不可宣稱已保證。

## 2. 產品定位與第一版交付

建立開源、本機優先的 CLI 核心，透過薄的 Skill 或宿主整合讓 Claude Code、Codex 使用。

第一版提供：

- 被動分析：辨識疑似無效讀取、搜尋及重試。
- 主動但明確啟用的優化：以一個受控的結構化測試結果工具，減少測試輸出的重複資訊，完整保留失敗證據並提供原始結果存取。
- 成對比較：確認優化是否真的減少整個任務 Token，並且通過品質門檻。
- 策略狀態：未驗證策略只能實驗性啟用，不能自動全面部署。

第一個優化場景限定為 **Jest 結構化測試結果**。這是刻意縮小工程範圍，並不代表 Jest 輸出一定是最大 Token 浪費來源。若真實測試無效，保留結論並換方向，不粉飾數據。

## 3. 與前版的關鍵差異

| 項目 | 本版要求 |
| --- | --- |
| 最終交付 | 診斷＋可運作優化工具＋品質與 Token 比較 |
| 診斷器 | 是量測基礎，不是產品終點 |
| 省 Token | 計算完整任務，包括提示、補讀、失敗、子 Agent 與額外模型成本 |
| 品質 | 獨立驗收；品質失敗即不可推薦策略 |
| 壓縮 | 原始結果保留；資訊不足可展開；仍須驗證品質 |
| 主動策略 | 先 opt-in；未知格式或完整性失敗就退回原輸出 |
| 廣泛相容 | 只宣稱實際測試過的宿主版本和入口 |

## 4. 非目標與禁止事項

第一版不建立新 Coding Agent、不修改模型、不做多模型分流，不建立雲端平台、登入、遙測、向量資料庫或多 Agent 協作系統。

不得：

- 暗中更改 reasoning effort、模型、context 上限、驗收條件或必要測試。
- 只縮短最後回答便宣稱整體任務省 Token。
- 把「輸出少了 80% bytes」寫成「整體費用省了 80%」。
- 將重讀、重搜、重試一律封鎖；必要的重新確認必須可做。
- 用今天的檔案 hash 證明昨天的檔案沒有變。
- 重用測試結果以跳過測試執行。**第一版不做測試結果快取。**
- 把舊 artifact 當目前程式狀態的驗證證據。
- 自動安裝全域 Hook、發布套件、推送遠端或上傳使用者紀錄。
- 直接執行 transcript 內的命令或指令。

## 5. 優化優先序

### P1：減少無效操作

偵測缺少執行檔、重複失敗、相同查詢等現象，提供可執行建議。首版是提醒，不自動阻止 Agent。只有具體環境前置檢查可由程式確定時才執行該檢查。

### P2：更精準取得資訊

優先讓工具回傳清楚的路徑、行號、失敗位置與必要上下文。任何範圍縮小都須標明 coverage、omitted 與擴展入口，不假裝結果完整。

### P3：受控減少工具輸出

先做已知結構的測試結果 renderer，再考慮其他輸出。保留所有失敗診斷；成功案例名稱彙整等仍可能丟失有用資訊，因此標為 selective view，不稱為語意無損。

CLI 的資料處理不使用 LLM。未來若新增 LLM 分析，其 Token 必須納入產品成本。

## 6. 技術方案

建議：TypeScript strict、Node.js 支援中的 LTS、pnpm、Zod、Commander、Vitest。這些是設計選擇；開發時核對相容版本並提交 lockfile。

採單一 package，不先建立 monorepo 或後端服務。核心模組與宿主 adapter 分離。

```text
src/
  cli.ts
  schema/          # events、artifacts、policies、evaluation
  adapters/        # canonical、claude-code、codex
  observe/         # 解析、usage 正規化、候選浪費規則
  runner/          # 明確執行的 Jest runner，不是任意 shell proxy
  renderers/       # 原始與結構化結果輸出
  artifacts/       # 原始資料、manifest、hash、展開
  policies/        # 模式、完整性檢查、回退
  evaluate/        # 成對比較、品質 gate、Token 統計
  privacy/         # 遮罩及安全顯示
  report/          # JSON、Markdown
integrations/      # 經驗證後才放入宿主設定與簡短 Skill
fixtures/          # 合成與去識別化真實樣本，分開標示
examples/
docs/
```

## 7. 使用模式與狀態

| 模式 | 行為 | 對 Agent 的輸出 |
| --- | --- | --- |
| observe | 讀取指定歷史紀錄 | 只產生診斷報告 |
| shadow | 實際執行工具並生成候選摘要 | 仍回傳原輸出；不宣稱有省 Token |
| optimize | 使用者明確啟用指定 policy | 通過完整性檢查才回傳結構化 view |
| passthrough | 關閉策略或遇到無法處理狀況 | 回傳原始結果，不重跑原命令 |

策略狀態：experimental → validated_for_scope；或 experimental／validated_for_scope → disabled。

validated_for_scope 必須綁定策略 hash、renderer 版本、宿主版本、模型設定、測試集 digest 與評估結果。不代表全球通用安全。任何作用域條件改變，退回 experimental，不沿用舊認證。

預設 observe／shadow。experimental 的 optimize 需要明確參數；CLI 不因存在一份歷史好成績就默默啟用。

## 8. 首個主動工具：Jest Result View

### 8.1 執行邊界

工具名稱暫定 `agent-efficiency test`。由使用者或 Agent 明確呼叫，執行目前專案已安裝且支援的 Jest。

- 查核專案 root 與本機 Jest；缺少時清楚報錯，不自動下載或安裝。
- 使用 argv array 與 shell=false 執行；不將參數拼成 shell 字串。
- 只支援一次性測試；拒絕 watch、互動模式及與結構化 reporter 衝突的參數，列出允許／拒絕條件。
- 不減少測試集合，不改測試 timeout、retries、coverage 或 worker 設定來取巧。
- 基線與優化組使用相同測試執行設定，差異只在結果呈現與整合開銷。
- 所有命令執行依宿主正常權限處理，不能繞過 permission／sandbox。
- 第一版支援的 Jest JSON 格式必須以真實 fixture 驗證，記錄版本；未知格式直接回退。

### 8.2 必須保留的資訊

結構化 view 至少包含：

- 執行 cwd 的安全顯示、命令、開始時間、執行時間。
- 原始 process exit code／signal、是否 timeout、是否執行完整。
- suites、tests 的 passed／failed／pending／skipped／todo 與可得的 snapshot 結果。
- **所有失敗項目**的名稱、檔案、原始失敗訊息、堆疊、expected／actual diff，不僅保留前幾筆。
- setup／teardown、未捕獲例外、環境與 reporter 錯誤。
- 原始 stderr；不得因 JSON 顯示通過便忽略 stderr 警告。
- 未歸類的 stdout 內容；無法判斷是否為冗餘訊息時保留原文。
- 確切列出省略了哪些類型，例如「通過的測試名稱」，以及 artifact 展開方式。

允許彙整通過案例名稱、已知 reporter 的重複成功摘要。不得使用通用正則任意刪除警告、錯誤或「看起來不重要」的行。

若無法可靠拆分 reporter 輸出與自訂 console 內容，使用完整原始輸出；寧可沒有節省。不要設定「所有 stdout 丟棄，只看 JSON」的捷徑。

### 8.3 選擇輸出的完整性 gate

優化 view 只在以下全成立時採用：

1. 格式與版本可辨識，結構化結果成功解析。
2. 過程完整，exit status 沒有遺失，結果不存在矛盾或未知關鍵欄位。
3. 必要失敗資訊完整，未歸類輸出有保留。
4. 原始 artifact 已成功保存並核對 hash。
5. view 的 bytes 比原始 stdout＋stderr 小；這只是避免明顯膨脹，不當成 Token 成效證明。

任一條件不成立：使用已捕捉的原始輸出，記錄 fallback reason，**不可重新執行測試來回退**。原始輸出過大仍不可靜默刪掉失敗證據；可以原文串流回傳，宿主本身的截斷必須在測試與文件中揭露。

### 8.4 Process status

正常結束時 wrapper 傳遞 Jest 原始 exit code；signal 可用平台慣例映射，但 manifest 必須保留原 signal 與映射方式。wrapper 自身錯誤與 Jest 測試失敗分開標記。逾時、取消、磁碟滿或寫入失敗不得回報測試通過。

## 9. Artifact 與回退

每次執行建立獨立 artifact：stdout、stderr、結構化結果與 manifest。manifest 記錄 SHA-256、runner／policy 版本、時間、命令摘要、退出狀態及 snapshot 描述。

- 預設位於使用者指定的本機資料目錄；不自動提交 Git。
- manifest 可含 base commit 及執行前後 dirty 狀態，但不能據此保證依賴／資料庫／環境沒有變。
- 原始資料不可變；展開只讀取 artifact，不重跑命令。
- artifact ID 不能任意解析成路徑；防止 traversal、跨工作目錄及不受控 symlink。
- 原始輸出可能有秘密；預設本機限制權限，不上傳。報告使用遮罩後摘要。
- `expand` 預設顯示 sanitized view；明確 raw 模式才回傳原始 bytes。遮罩不得被宣稱為完整保護。
- 本機原始檔是取證／重現資料，不能被當作目前程式通過測試的證明。
- 活躍 session 的 artifact 不自動清除；提供明確 prune 指令及 dry-run，預設不刪除。
- 同一次結果一次展開後，不反覆推送警告。資料不存在或 hash 不符時明確報錯。

原文可取回是必要保護，不是品質保證：Agent 可能不知道有東西被省略。這正是獨立品質評估不可省略的原因。

## 10. 診斷規則

所有 finding 都是候選浪費，需有 source_ref、event IDs、信心、限制與建議，不是自動封鎖理由。

| 規則 | 初始門檻 | 必須排除／揭露 |
| --- | --- | --- |
| R001 重複讀取 | 同 stream 最近 20 calls，相同 path、range 與實際內容 hash ≥3 次 | 使用者新需求、已知改檔、compaction 會重置；部分 hash 不能代表整檔版本 |
| R002 重複搜尋 | 同 stream 最近 20 calls，相同 query／scope／flags ≥3 次 | 縮小範圍或改 flags 不算；缺結果 hash 降低信心 |
| R003 環境失敗重試 | 最近 10 calls，同 cwd／命令，明確 command_not_found 等錯誤 ≥3 次 | 安裝／修復／未知環境操作後切開；網路錯誤與 flaky test 不算 |
| R004 壓縮後補讀 | 有明確 artifact linkage，後續 10 calls 內展開 | 事件可以確定，但壓縮造成浪費的因果仍 unproven |

不同子 Agent、session 或 context epoch 不混成一組。缺少必需資料就 not_evaluable，不填成零。門檻可配置，報告列出採用設定。不要從讀取次數判定 Skill 無關，也不要自動刪除 Skills。

## 11. 資料契約

以下是自訂 schema，不是任何宿主的官方格式。實作以 Zod discriminated union 驗證不同 type 的必要欄位。

```ts
interface EventBase {
  schema_version: 2;
  id: string;
  task_id: string;
  run_id: string;
  session_id: string;
  stream_id: string;
  context_epoch?: string;
  sequence: number;
  timestamp?: string;
  source_ref: { input_id: string; line: number; pointer?: string };
}

type EventType = 'tool_call' | 'tool_result' | 'file_change'
  | 'user_message' | 'context_boundary' | 'usage' | 'session_end';

interface ToolObservation extends EventBase {
  type: 'tool_call' | 'tool_result';
  tool_call_id: string;
  category: 'read' | 'search' | 'shell' | 'edit' | 'other';
  tool_name: string;
  content_hash?: string;
  file_version_hash?: string;
  path?: string;
  range?: { start: number; end: number };
  args?: Record<string, unknown>;
  exit_code?: number;
  signal?: string;
  output_bytes?: number;
  truncated?: boolean;
  artifact_id?: string;
  policy_id?: string;
  expanded_from_artifact_id?: string;
}

interface RequestUsage {
  request_id: string;
  input_uncached: number;
  input_cache_read: number;
  input_cache_write: number;
  output_total: number; // 若含 reasoning，不可再加一次 reasoning
  reasoning_included_in_output?: number; // 僅作拆分顯示
  scope: 'request';
  origin: 'provider_reported';
}
```

上述 RequestUsage 只代表可完整正規化的紀錄。實際 parser 另用 incomplete variant 保存 partial 欄位與 missing_fields，不能因欄位缺漏就補 0。

每個宿主 adapter 必須列出支援版本、真實去識別化 fixture、可觀測的工具與子 Agent 範圍、usage 的累計／增量語意，以及 cache／reasoning 計數方式。使用 tool_call_id 配對，不靠相鄰行猜測。

若父 session aggregate 已含子 Agent，與子 Agent request 不可重複加總。累計 counter 必須轉 delta 並處理 reset。無法對齊時標為 incomplete，不能對外宣稱完整任務節省量。

## 12. 整體 Token 計量

在同一宿主、同一模型與相同計量語意的成對實驗中：

```text
T_task = Σ各唯一 request(
  input_uncached + input_cache_read + input_cache_write + output_total
)
```

只有 adapter 確認三類 input 互斥時才使用此式。原始 input_total 已含 cache 時先拆分；reasoning 已含於 output_total 時不重算。未知時回報 incomplete。

T_task 包括系統／Skill／工具描述、所有回合的重複 context、補讀、重試、子 Agent、compaction 模型呼叫，以及優化器額外模型呼叫；不可觀測者列為缺口。核心 CLI 沒有模型呼叫，但其輸出與新增 Skill 一樣會增加宿主 Token。

任務邊界是首次接收固定需求，到完成最終結果或到達共同停止條件，不能只選最省的一段。基線與優化組皆包含失敗與 timeout 的成本。

```text
observed_token_reduction = 1 - ΣT_optimized / ΣT_baseline
```

僅在相同任務／重複配置且計量完整時輸出此比例。基線總量為零時無法計算。另報每任務配對差異、中位數、分布與信賴區間，避免單一大型任務支配結論。

bytes reduction、provider Token、費用、耗時分開顯示。費用用來源實報或明確日期的使用者價格設定估算；不能把較低價格的 cached Token 與 uncached Token 費用等同。減少費用但 Token 未下降，不算本目標達成。

## 13. 品質門檻與結論狀態

### 13.1 預先定義任務驗收

每個任務 manifest 必須在跑實驗前定義：

- 固定需求、base commit、依賴與環境設定。
- 必須通過的獨立測試，含邊界案例與回歸測試。
- build／typecheck 等適用檢查；不適用者明確寫 N/A。
- API 相容、資料完整性、安全要求及禁止變更。
- 是否完整完成需求、是否用跳過／刪除測試逃避失敗。
- 可維護性等需要人工的 rubric，使用相同標準，盡量盲評。

驗收由 Agent 無法任意更改的外部 verifier 執行。Agent 自己說「完成」不算成功。測試全綠不必然代表需求完整，必要時加結構化人工驗收。

### 13.2 每次執行

Pass 必須所有硬性條件成立。部分完成、timeout、錯誤宣告成功、遺漏需求、無法驗證均不得計為 Pass。verifier 基礎設施故障另列 invalid，保留紀錄、成對處理及明確原因，不把優化器 crash 當基礎設施故障剔除。

### 13.3 實驗結論

- `regressed`：有確認的關鍵品質／安全退步，或經重現確認策略造成失敗；不可推薦。
- `inconclusive`：樣本不足、usage 不完整、驗收缺漏或統計證據不足。
- `no_gain`：品質 gate 通過，但沒有足夠 Token 改善證據。
- `validated_for_scope`：在指定評估範圍通過以下全部條件。

validated_for_scope 門檻：

1. 所有安全與資訊完整性 fixtures 通過。
2. 無確認的策略導致關鍵品質回歸，人工 rubric 各維度沒有退步。
3. 成功率差 Δ = optimized − baseline 的預先指定單側 95% 信賴下界 ≥ 0；不使用寬鬆容忍差偷換「不降低」目標。
4. 完整任務 Token 相對改善的單側 95% 信賴下界 > 0。
5. 暫定產品價值門檻：觀測 Token 改善 ≥5%；這是設計門檻，不是已達成效果。

有限樣本下第 3 點可能很難通過，尤其兩組都全數成功時；此時應標 inconclusive／可實驗使用，而不是捏造保證。即使通過，也只陳述指定評估範圍內的證據。

統計方法須於看結果前固定。成功率使用適合成對二元資料的 score／exact 方法；重複執行涉及同任務相依時以任務為 cluster 處理。Token 可用按任務 cluster 的配對 bootstrap。不得把同任務多次執行當完全獨立樣本，或用退化 bootstrap 在全數成功時製造零寬區間。方法無可靠實作時，先輸出觀測值與 inconclusive，不能硬填 CI。

## 14. 實驗設計

先做 10 個任務、每組每任務至少 3 次的探索性 pilot；這是找問題，不是足以保證品質的固定樣本數。

- A0：宿主原本測試流程。
- A1：wrapper passthrough／shadow，保留所有輸出。
- B：相同 wrapper＋候選 policy。

A1 對 B 區分 renderer 效果；A0 對 B 才代表使用者實際端到端效益。必須計入新增 Skill、工具描述與額外操作成本。

固定模型、reasoning effort、Agent 版本、permissions、最大任務時間、停止條件、硬體與依賴。每次從相同乾淨工作區開始，隔離 session／記憶／artifact，不讓前一組洩漏答案。對 prompt cache 暖冷狀態記錄並交錯／隨機安排，不假設供應商 cache 一定可清除。

訓練策略的任務與保留評估集分開。一次只測一個策略變因；不得調到測試集最好後宣稱泛化。失敗成本與不可完成任務都列出；同時報告總 Token／成功任務數，成功數為零則不計算。

付費執行必須另有使用者指定的任務與預算。首版 compare 可以只讀已完成 run manifests，不必自動呼叫 Agent API。

## 15. CLI 契約

以下是待實作介面，不代表已存在的命令。

```bash
agent-efficiency analyze ./session.jsonl --adapter canonical --out-dir ./report
agent-efficiency test --mode shadow --project-root . --run-dir ./run-001 -- <jest-args>
agent-efficiency test --mode optimize --policy jest-v1 --allow-experimental --project-root . --run-dir ./run-002 -- <jest-args>
agent-efficiency expand <artifact-id> --run-dir ./run-002 --part failures
agent-efficiency expand <artifact-id> --run-dir ./run-002 --part stdout --raw
agent-efficiency compare ./experiment.json --out-dir ./comparison
agent-efficiency policies
agent-efficiency adapters
```

- 不自動挑選使用者所有歷史紀錄。路徑必須明確指定。
- report／comparison 輸出 JSON 與 Markdown；已存在時須 `--overwrite` 才覆寫。
- run-dir 須為新目錄，避免 artifact 混用。
- analyze／compare：0 成功產生報告、1 I/O／執行錯誤、2 格式不支援或資料無效。品質結論存在 report 中，不把「產生報告成功」當 gate 通過。
- test：沿用第 8 節 process exit 契約，不套用 analyze exit 規則。
- JSONL 損毀行可在非 strict 模式繼續，但標明 partial、行號與 coverage；strict 失敗。
- 超大輸入串流處理，單行設可配置上限；不得 OOM 後誤回成功。
- config 使用純 JSON，不能載入可執行 JS；設定與報告都不執行來源文字。

## 16. 必要測試

| 類別 | 案例與預期 |
| --- | --- |
| 通過測試 | 彙整成功名稱，數量與 exit code 相符，有展開入口 |
| 失敗測試 | 所有失敗名稱、訊息、stack、diff 保留 |
| 多種狀態 | skipped／todo／pending／snapshot 正確，不混成通過 |
| 特殊輸出 | stderr、自訂 console、Unicode、多行差異不靜默丟失 |
| 不明格式 | 未知 Jest 版本、壞 JSON、缺欄位 → 原輸出 |
| 矛盾狀態 | exit 非零但 JSON 全綠 → 不回傳通過摘要 |
| 回退 | 不重跑原命令；原始 status 不變 |
| 執行異常 | timeout、signal、取消、磁碟滿不能回報通過 |
| Artifact | hash mismatch、刪除、越界路徑清楚報錯 |
| 讀取版本 | 改檔、compaction、新需求後重讀不視為舊組浪費 |
| 計量 | cache 互斥、reasoning 不重算、父子去重、累計 reset |
| 不完整資料 | usage 不完整 → inconclusive，不填零 |
| 安全 | transcript 含命令／提示注入不執行；報告遮罩及轉義 |
| 品質 gate | Token 下降但正確率退步 → regressed |
| 成效 gate | bytes 下降但 T_task 上升 → no_gain 或 inconclusive |
| 統計邊界 | 全數成功的小樣本不可給零寬 CI 並宣稱保證 |
| 實際接入 | 經測宿主真的呼叫 wrapper，記錄 adoption，不能假定 Skill 一定生效 |

單元與 fixture 測試只能證明程式行為，不能替代真實 Agent 任務實驗。

## 17. Claude Code／Codex 整合

首版採 CLI＋簡短 Skill 的入口，不假定兩者 Hook API、Plugin 格式或 transcript schema 相同。

開發時讀取當前官方文件並以本機實際版本驗證。建立 adapters.md 與 integrations.md，逐項記錄：

- 宿主／版本、啟動方式、工具是否可呼叫 CLI。
- usage 是否涵蓋 cache、reasoning、子 Agent、compaction。
- 原生 Read／Grep 是否完全繞過此工具。
- Skill 是建議入口，還是確實有被呼叫的可觀測證據。
- 未支援項目及受測的 fixture。

缺乏可靠樣本時，canonical pipeline 與獨立 CLI 照常完成，宿主項目標 experimental／unsupported。只有 stub 不算支援。

Skill 的設計內容：在合適的 Jest 任務使用 test 工具；閱讀所有失敗；需要被省略資訊時 expand；未知格式沿用原流程；不調低推理、不跳驗收、不重用舊測試證據。不要附上一長串與每次任務無關的規則，Skill 本身的 Token 也納入測量。

## 18. 隱私、權限與開源

核心離線，不含遙測與雲端帳號。只處理指定紀錄與專案；執行測試可能使用專案自己的網路行為，工具不能宣稱可阻止全部外連。

報告預設只含統計、事件 ID、相對路徑、來源行號及遮罩後內容。不複製完整 prompt。原始 artifacts 與 fixtures 分開；發布前確保 fixtures 沒有真實憑證。

Markdown 轉義不可信內容，避免任意 HTML／外部圖片。遮罩不保證涵蓋所有秘密。原始 artifact 可由明確 raw 存取，不任意修改其原始 bytes。

預定 MIT 授權；沿用使用者既有授權決定。發布前確認依賴授權、套件名稱與來源；不自動發布。

## 19. 開發里程碑與完成定義

### M0：起點與契約

閱讀現有 repo、AGENTS.md／CLAUDE.md，保留修改。確認本機 Node／Jest／宿主版本及可用 samples。建立 TypeScript package、schema、fixtures、簡短計畫。不要為了套用本規格重建現有專案。

### M1：量測基礎

完成 canonical JSONL parser、usage 正規化、R001～R004、JSON／Markdown 報告。每條規則有正例、負例及未知資料案例。M1 不是整個專案完成。

### M2：可用優化路徑

完成 Jest runner、artifacts、renderer、shadow／optimize／passthrough、expand、完整性 gate。實際在受測 Jest 專案執行通過與失敗測試，確認 exit code 與原文可取回。必須有這個 milestone 才能稱為可用優化原型。

### M3：比較與品質 gate

完成 task／run／experiment manifests、離線 compare、品質結論及 Token 報告。允許缺正式統計實作時回傳 inconclusive，不能假造顯著性。新增範例實驗資料並標為合成，不冒充節省實測。

### M4：真實宿主整合

優先完成有資料可驗證的 Claude Code 路徑，再驗證 Codex。補短 Skill、相容矩陣及真實去識別化 fixtures；不虛構 adapter。未具備宿主測試環境時完整列出可重現驗證步驟與未完成項目。

### M5：效益驗證與發布準備

交付 pilot 腳本／清單，獲得測試預算後跑成對實驗。若只有工程測試完成，稱「原型已完成，效益未驗證」。若品質退步或無 Token 改善，保留結果並停用候選策略。

最後交付 README、架構、資料契約、隱私、限制、測試結果、示例報告、授權及貢獻指南。執行 typecheck、build、單元／整合測試與 README 命令。

產品工程完成與「已證實省 Token」是不同狀態，最終報告分開說明。

## 20. 後續方向與研究入口

之後可增加受控的上下文定位、NestJS API 關聯檔案包、規則矛盾檢查，以及依補讀率調整壓縮。但必須通過相同品質／Token 評估流程，不在第一版同時做四個產品。

先前公開搜尋已找到輸出壓縮、Agent 記憶、自動優化 Skills、衝突偵測等相近工具，不宣稱完全無競品。以下只作前期研究入口，實作前核對功能、版本與授權：

- RTK：<https://www.rtk-ai.app/index.html>
- trs：<https://github.com/dPeluChe/trs>
- projectmem：<https://github.com/riponcm/projectmem>
- EvoSkill：<https://github.com/sentient-agi/EvoSkill>
- Skill 評估框架：<https://github.com/adewale/skill-eval-harness>
- Context Mode：<https://github.com/mksglu/context-mode>
- JetBrains RTK 評估：<https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/>

差異化是待驗證的產品假設：**以可追溯工具輸出與嚴格品質門檻，驗證整個 Coding Agent 任務的 Token 改善。**

## 21. 可直接貼給 Claude 的啟動指令

```text
請閱讀 agent-efficiency-spec.md v0.2，依 M0～M4 開始實作。

核心目標：在不降低任務正確率與完成品質的前提下，減少整個 Coding Agent
任務的 Token 使用量。不可調低模型或 reasoning effort、刪必要測試、縮短
需求或提前停止來達標。

先檢查現有 repo 與適用的 AGENTS.md／CLAUDE.md，保留既有修改，列出簡短
計畫後開始。先做量測，再完成 Jest Result View 的實際優化路徑，包括原始
artifact、展開、完整性 gate、pass-through 與保留 exit code。不要只交付
診斷器就停止，也不要擴張成雲端平台。

加入完整任務 Token 比較與獨立品質 gate。缺資料／樣本不足就 inconclusive，
不要宣稱已保證不影響思考或已省下某個百分比。原文可以補讀不代表品質已保證。

宿主格式以當前官方文件與真實 fixture 為準。缺 Claude Code／Codex 樣本時
完成 canonical 與獨立 CLI，標明整合限制，不虛構支援。

完成後執行 typecheck、build、正反例測試及真實 Jest CLI 驗證，分別回報
「工程完成度」與「效益驗證狀態」。付費 benchmark、全域 Hook、遠端發布與
紀錄上傳不自動執行；先交付可重現的實驗設定。
```
