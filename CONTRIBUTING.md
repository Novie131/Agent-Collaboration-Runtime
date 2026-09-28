# 貢獻指南

## 開發

```bash
corepack pnpm install
corepack pnpm typecheck && corepack pnpm test && corepack pnpm build
```

## 原則

- 品質優先：任何改動不可降低模型／reasoning 設定、刪除必要測試或提早宣告完成來換取 Token。
- 不確定就回退：新格式或無法驗證的輸出一律回傳原始內容。
- 不虛構支援：新宿主或新 Jest 版本需附上真實（去識別化）fixture 與測試，才可列入已驗證清單。
- 數據誠實：bytes、provider Token、費用、耗時分開呈現；證據不足標 `inconclusive`。

## 新增已驗證的 Jest 版本

1. 在 `examples/jest-sample` 安裝該版本（`--ignore-workspace`）。
2. `corepack pnpm build && node scripts/capture-jest-fixtures.mjs`。
3. 確認 `test/real-fixtures.test.ts` 全數通過後，才把版本加入 `src/policies/registry.ts` 的 `verified_jest_versions`／`verified_jest_majors`（policy hash 會改變，任何既有驗證隨之失效）。

## 新增宿主 adapter

在 `docs/adapters.md` 記錄版本、可觀測工具、子 Agent、usage 的累計／增量語意、cache／reasoning 計數方式與缺口；附去識別化 fixture（可參考 `scripts/deidentify-claude-transcript.mjs`）。未經驗證前狀態為 experimental 或 unsupported。

## Fixtures

合成樣本放 `fixtures/synthetic/`，真實輸出放 `fixtures/real/`，並在 meta 或文件說明來源。提交前確認不含憑證、個人資料或真實 prompt 內容。
