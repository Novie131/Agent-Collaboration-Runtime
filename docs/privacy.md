# 隱私、權限與安全

- **離線**：核心不連網、無遙測、無帳號。執行測試時，專案自己的測試碼仍可能連網；本工具無法阻止。
- **只處理指定輸入**：`analyze` 只讀命令列給的檔案；`test` 只在 `--project-root` 執行本機已安裝的 Jest，不下載、不安裝。
- **不執行紀錄內容**：transcript 中的命令、提示或「指令」只被解析與雜湊，從不執行。設定檔是純 JSON，不載入 JS。
- **命令執行**：argv 陣列＋`shell: false`；遵循宿主既有的權限／sandbox，不繞過。
- **Artifact**：存放於使用者指定的 run-dir（目錄 0700、檔案 0600），不自動提交 Git、不上傳。原始檔不可變；`expand` 只讀檔並核對 SHA-256。artifact id 只做格式比對，從不當成路徑；拒絕 symlink 與越界路徑。
- **遮罩**：報告與 `expand` 預設套用遮罩（AWS/GitHub/Slack/API key、JWT、Bearer、URL 帳密、`*PASSWORD=`/`*TOKEN=` 等）。**遮罩是盡力而為，不是完整保護。** `--raw` 會回傳原始 bytes。
- **報告內容**：統計、事件 ID、相對路徑、來源行號與遮罩後摘要；不複製完整 prompt。Markdown 會轉義不可信文字，不產生 HTML 或外部圖片。
- **Test view 不遮罩**：optimize 模式的 view 取代的是 Agent 原本就會看到的原始輸出；若遮罩可能改變測試失敗資訊，因此 view 與原始輸出一樣未遮罩。
- **Fixtures**：`fixtures/real/jest-29.7.0` 是合成測試碼的真實 Jest 輸出，路徑已替換為 `<ROOT>`／`<RUN>`／`~`。`fixtures/real/claude-code-2.1.283` 由本專案開發 session 產生，所有文字、命令與工具結果都換成 hash，ID 重新編號，只保留專案內相對路徑與 usage 數字。發布前請再次檢查。
- **清理**：`prune --root <dir> --older-than 7d` 預設只列出；需 `--apply` 才刪除。不會自動清除。
