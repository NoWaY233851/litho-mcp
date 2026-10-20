# litho-mcp
[![CI](https://github.com/NoWaY233851/litho-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/NoWaY233851/litho-mcp/actions/workflows/ci.yml?query=branch%3Amain)

[English](README.md) | 繁體中文 | [简体中文](README.zh-CN.md)

> 本文譯自英文版 [README.md](README.md)。兩者內容不一致時，以英文版為準。

litho-mcp 是一個在 Vercel 上以單一 Node.js 函式執行的遠端 [MCP](https://modelcontextprotocol.io) 伺服器。把它加到 claude.ai 成為自訂連接器後，Claude 就能在對話中透過 [OpenRouter](https://openrouter.ai) 產生與編輯圖片，結果直接顯示在對話裡。它的設計已在 claude.ai 網頁版、Claude 桌面版與 Claude iOS App 上驗證過。

每個部署只服務一個人：部署它的那個人。沒有資料庫，也沒有登入流程。連接器以一組放在請求標頭中的共用密鑰進行驗證。

工具：

- `generate_image`：依文字提示產生圖片，可使用任何 OpenRouter 圖片模型。
- `edit_image`：編輯圖片，或以參考圖片建立新圖。參考圖可以是這個伺服器產生的圖片、你上傳的照片，或公開的 http(s) 網址。
- `upload_image`：在對話中顯示上傳按鈕，讓你從裝置挑選照片。
- `list_models`：列出 OpenRouter 的圖片模型，以及各模型支援的參數。

設計內容、被否決的替代方案與理由，都記錄在 [docs/design/](docs/design/README.md)（英文）。

## 需求

- 一個在自訂連接器中有 **Request headers**（請求標頭）選項的 claude.ai 帳號。這項功能目前是測試版，開放範圍有限。沒有它，litho-mcp 無法驗證身分，也就無法使用（見 [ADR 0009](docs/design/0009-connector-secret-header.md)）。
- 一個 Hobby 方案的 Vercel 帳號。
- 一把設定了**支出上限**的 [OpenRouter](https://openrouter.ai) API 金鑰：在 OpenRouter 後台建立金鑰，並替它設定額度上限。伺服器本身從不限制模型花費，所以金鑰上的上限就是你花費的上限。
- 用來部署的電腦上要有 Node.js 22.19 或更新版本。

## 部署

所有指令都在本儲存庫的 clone 中執行。如果你的 CLI 版本不同，請用 `npx vercel <command> --help` 核對參數；以下指令是在 2026-10-18 以 Vercel CLI 64.5.0 核對的。

1. 登入，並建立及連結專案：

   ```
   npm install
   npx vercel login
   npx vercel project create <name>
   npx vercel link --yes --project <name>
   ```

   直接執行 `npx vercel link` 也可以，它會以互動方式逐一詢問。

2. 建立一個**公開（Public）**的 Blob store。它存放圖片，圖片直接由 Blob 網址提供（見 [ADR 0010](docs/design/0010-vercel-blob-storage.md)）。建議的做法是用 Vercel 後台（以下標籤為 2026-10-19 的版本，之後可能會變）：

   1. 在 Vercel 後台選 **Create Blob Store**，存取權限設為 **Public**。
   2. 把 store 連接到專案的 Production 與 Preview 環境。
   3. 不要勾選 **Add a read-write token env var to this connection**。

   連接後會新增 `BLOB_STORE_ID`（以及伺服器用不到的 `BLOB_WEBHOOK_PUBLIC_KEY`），但不會新增 token。函式之後會用 Vercel 附加在每次呼叫上的 OIDC token 存取 Blob，所以專案裡沒有長期有效的 Blob 密鑰。Cron 呼叫同樣會拿到這個 token，所以每日清理也以相同方式運作。

   另一個受支援的做法是用 CLI：

   ```
   npx vercel blob create-store <name> --access public --yes
   ```

   加上 `--yes` 時，store 會連接到 Production、Preview 與 Development，CLI 也會在這三個環境把 `BLOB_READ_WRITE_TOKEN` 設為一般（Config）變數。它不會設定 `BLOB_STORE_ID`；伺服器會從 token 推導出 store id。這樣可以運作，代價是這個能寫入並刪除所有圖片的 token，在後台和 `npx vercel env pull` 中都讀得到。

   兩者都存在時，以 token 為準。若在 CLI 設定之後想改用 OIDC，請移除 `BLOB_READ_WRITE_TOKEN`，並確認已設定 `BLOB_STORE_ID`。

3. 產生兩組密鑰。每組至少要 32 個字元，太短的話伺服器會拒絕提供服務：

   ```
   CONNECTOR_SECRET=$(openssl rand -base64 32)
   CRON_SECRET=$(openssl rand -base64 32)
   ```

   現在就把 `CONNECTOR_SECRET` 的值存進密碼管理器（macOS 上可用 `printf %s "$CONNECTOR_SECRET" | pbcopy` 複製）。以 sensitive 變數存進 Vercel 後就無法再讀回，而設定連接器標頭時還會用到它。在下一步完成前，請保持這個 shell 視窗開著，或改用存下來的值。

4. 加入 [.env.example](.env.example) 裡的變數。應用程式密鑰只放在 **production**：單人使用的部署在 Preview 或 Development 都用不到它們，複製過去只會擴大暴露範圍。Preview 部署因此會回應 `500` 與 `server_misconfigured`，這是預期中的結果。本機執行時讀取依 `.env.example` 填寫的 `.env.local`，這個檔案已被 gitignore，也從不上傳。密鑰請透過 stdin 傳入，不要用 `--value`，以免留在 shell 歷史紀錄中：

   ```
   printf %s "$CONNECTOR_SECRET" | npx vercel env add CONNECTOR_SECRET production --sensitive
   printf %s "$CRON_SECRET" | npx vercel env add CRON_SECRET production --sensitive
   npx vercel env add OPENROUTER_API_KEY production --sensitive
   ```

   最後一個指令會提示你輸入金鑰。可選的一般變數：

   ```
   npx vercel env add RETENTION_DAYS production --value 30 --no-sensitive --yes
   npx vercel env add DEFAULT_MODEL production --value <model id> --no-sensitive --yes
   ```

   | 變數 | 必要 | 說明 |
   |---|---|---|
   | `OPENROUTER_API_KEY` | 是 | 所有圖片請求使用的 OpenRouter 金鑰。 |
   | `CONNECTOR_SECRET` | 是 | claude.ai 放在 `Authorization` 標頭中傳送的密鑰。至少 32 個字元。 |
   | `CRON_SECRET` | 是 | Vercel Cron 傳給清理路由的密鑰。至少 32 個字元。 |
   | `BLOB_READ_WRITE_TOKEN` | 兩者擇一 | store 的讀寫 token，由 CLI 做法以一般變數寫入。設定後，所有 Blob 呼叫都使用它。 |
   | `BLOB_STORE_ID` | 兩者擇一 | store id，可帶或不帶 `store_` 前綴。沒有 token 時必填，此時函式使用平台的 OIDC token。有 token 時可省略；若設定，會取代 token 內的 id 來決定公開網址的基底。 |
   | `DEFAULT_MODEL` | 否 | 呼叫未指定模型時使用的模型。留空則使用內建預設值。 |
   | `RETENTION_DAYS` | 否 | 圖片保存的天數。留空代表 30 天。 |
   | `OPENROUTER_REFERER` | 否 | 傳給 OpenRouter 的 `HTTP-Referer`。留空則不傳送。 |

   缺少必要變數、必要變數強度不足，或兩個 Blob 變數都沒有，伺服器都會回應 `500` 與 `server_misconfigured`。記錄只會寫出變數名稱，從不寫出它的值。

5. 部署：

   ```
   npx vercel --prod
   ```

   這個指令會印出兩個網址。請使用標示為 `Aliased` 的那個：它是專案的正式網域，本文以 `<project>.vercel.app` 代稱。標示為 `Production` 的是這一次部署自己的網址，它在 Vercel 的部署保護之後，會回應 `302`，所以不要把它用在連接器或下方的檢查。

6. 確認端點會拒絕未經驗證的請求：

   ```
   curl -i -X POST https://<project>.vercel.app/mcp
   ```

   回應必須是 `401` 與 `{"error":"unauthorized"}`。

   這項檢查不會碰到 Blob。下一節有第二項會碰到 Blob 的檢查。

## 在 claude.ai 新增連接器

1. 開啟 **Customize > Connectors**，新增自訂連接器。
2. URL：`https://<project>.vercel.app/mcp`。
3. 驗證方式：**No sign-in**（不使用 OAuth）。claude.ai 會對這個選擇顯示警告，這是預期中的：下一步的請求標頭就是驗證方式。
4. 請求標頭：名稱 `Authorization`，值 `Bearer <CONNECTOR_SECRET>`。
5. 第一次請在 claude.ai 網頁版或桌面版新增，含請求標頭的對話框在那裡最容易操作。對話框顯示標頭值時，不要截圖或分享。

新增會直接完成，不會出現「Continue anyway」步驟。新增過程中，claude.ai 會送出一個不帶標頭的 `initialize` 請求並得到 `401`，也會在 `/.well-known/` 下尋找 OAuth metadata 並得到 Vercel 的靜態 `404`。兩者都是預期中的。在 Vercel 的請求記錄中，前者只顯示為一筆 `401`，伺服器本身不會為它寫任何記錄。

### 第一次測試：上傳照片

在任何生成之前，先請 Claude 呼叫 `upload_image`，然後在 widget 中挑任一張照片。這是建議的第一次測試，因為它不花錢：不會送出任何 OpenRouter 請求。widget 顯示照片已上傳，就代表 Blob token、store id，以及由它們推導出的公開圖片網址都從頭到尾正常運作。否則，錯誤的 Blob 基底網址（錯誤的 `BLOB_STORE_ID`，或 token 中無法使用的 store id）要到第一次付費的 `generate_image` 才會出現：在模型已經計費之後，才以「could not be saved」失敗。

如果 widget 回報照片無法上傳，代表伺服器回應了「The photo could not be saved. Try uploading it again.」，並在該部署的 Vercel 記錄中寫下原因 `upload save failed: <reason>`。原因會是下列其中之一：

- `blob base URL mismatch`：Blob 接受了寫入，但它回傳的網址與伺服器從 `BLOB_STORE_ID` 或 token 推導出的網址不同。請修正或移除 `BLOB_STORE_ID`，重新部署後再試。
- Blob SDK 的錯誤，例如 token 無效或已被撤銷：請檢查 `BLOB_READ_WRITE_TOKEN`。沒有 token 時，請確認 store 已連接到你正在測試的環境。

如果 claude.ai 回報「Connection issue」，說伺服器要求登入（狀態 401），代表標頭值錯誤或缺漏。

### 使用方式

claude.ai 有自己製作視覺內容的方式，遇到「畫一張食譜卡」這類請求時，可能會改用它們。在一段對話中第一次使用時，請指名連接器，例如「用 litho-mcp 產生一張食譜卡」，或明確要求一張圖片，例如「產生一張食譜卡的圖片」。litho-mcp 在一段對話中用過一次之後，Claude 在該對話中就會繼續使用它。

## 輪替密鑰

1. 產生新值並存進密碼管理器：

   ```
   CONNECTOR_SECRET=$(openssl rand -base64 32)
   printf %s "$CONNECTOR_SECRET" | pbcopy   # macOS；其他系統請手動複製
   ```

2. 取代這個變數。不要在 `CONNECTOR_SECRET` 為空時執行，否則伺服器會拒絕提供服務。

   ```
   printf %s "$CONNECTOR_SECRET" | npx vercel env add CONNECTOR_SECRET production --sensitive --force
   ```

3. 用 `npx vercel --prod` 重新部署。舊的連接器會立即失效，claude.ai 會顯示「This connector's stored credential was rejected」。這則訊息指的是連接器密鑰，不是 OpenRouter 金鑰。
4. 在 claude.ai 移除連接器，再用新的標頭值重新新增。既有連接器的標頭無法編輯。

`env add --force` 可以取代任何變數，所以 `CRON_SECRET` 與 `OPENROUTER_API_KEY` 也以相同方式輪替（OpenRouter 金鑰請先在它的後台建立新的）。輪替 `CRON_SECRET` 不需要更動連接器。

## 保存期限

圖片會在建立 `RETENTION_DAYS` 天後刪除（預設 30 天）。清理由每天執行一次的 Vercel Cron 工作負責，時間約在 UTC 03:00（見 `vercel.json`；Hobby 的 cron 時間只精確到小時），所以圖片最多可能比設定多留約一天。變更 `RETENTION_DAYS` 要在重新部署後才會生效。

## 限制

- 超出 Vercel Hobby 或 Blob 的配額，服務會暫停最多 30 天。Hobby 與 Blob 不會對超額收費。
- Hobby 方案僅限非商業用途。
- 模型費用由 OpenRouter 計費，上限只取決於你在金鑰上設定的額度。

## 安全性說明

回報漏洞請依照 [SECURITY.md](SECURITY.md)（英文），不要開公開的 issue。

- 圖片連結是 capability URL：Blob store 是公開的，任何持有連結的人都能看到那張圖片。連結無法猜測，也不會被列在任何地方，但請把它們當成共享的秘密看待。圖片會在保存期限過後刪除。
- Vercel Blob 會把每一次下載都計入 Hobby 的資料傳輸配額，快取命中也算：每月 10 GB（2026-10-18 於 <https://vercel.com/docs/vercel-blob/usage-and-pricing> 核對，該頁更新於 2026-09-23）。超出會讓 Blob 存取暫停最多 30 天，所以一個被廣泛分享的連結可能讓整個部署暫停。
- 要撤銷一張外洩的圖片，執行 `npx vercel blob del <url>`（參數以 Vercel CLI 64.5.0 核對；另見[開發](#開發)中關於 `--oidc-token` 的說明）。由於 CDN 傳播需要時間，圖片在刪除後最多約 60 秒內仍可能被存取。
- 使用 OIDC 時，專案不持有任何 Blob 密鑰。使用 `BLOB_READ_WRITE_TOKEN` 時，任何能讀取專案變數的人都能寫入並刪除所有圖片。
- `CONNECTOR_SECRET` 是長期有效的 bearer 密鑰。任何持有它的人，都能透過這個伺服器使用你的 OpenRouter 金鑰。它以固定時間比對，錯誤的密鑰與缺少密鑰得到的回應相同。
- 沒有 OAuth，也沒有每個工作階段的登入。輪替需要手動進行（見上文）。
- 傳給 `edit_image` 的網址，由伺服器通過 SSRF 檢查後才擷取（見 [ADR 0007](docs/design/0007-reference-urls-ssrf.md)）。
- `npx vercel link` 與 `npx vercel env pull` 會把真實的 token 寫進 `.env.local`。符合 `.env*` 的檔案都已被 gitignore，`.vercelignore` 中的允許清單也會把它們排除在部署上傳之外。不要把它們複製到別處。
- `public/robots.txt` 禁止爬蟲抓取這個部署。
- 伺服器從不記錄請求或回應的內容、密鑰或 token。

## 開發

```
npm test            # 建置 widget，然後執行 vitest
npm run typecheck   # 伺服器與 widget 的 TypeScript 型別檢查
npm run hygiene     # 掃描受追蹤的檔案中是否有個人資訊
npx vercel dev      # 在本機執行函式（需要環境變數）
```

測試從不連網。每次 commit 前都要執行 `npm run hygiene`。

`npx vercel link` 會在 `.env.local` 寫入 `BLOB_READ_WRITE_TOKEN` 與 `VERCEL_OIDC_TOKEN`，但不會寫入 `BLOB_STORE_ID`。在 Vercel CLI 64.5.0 下，`npx vercel blob` 指令接著會失敗，訊息是「VERCEL_OIDC_TOKEN and BLOB_STORE_ID must both be set, or both be unset」。請刪除 `VERCEL_OIDC_TOKEN` 那一行，或傳入對應的參數（`--rw-token`，或 `--oidc-token` 搭配 `--store-id`）。如果你的 CLI 版本不同，請核對目前的行為。

與主機相關的程式碼都放在小型轉接層（adapter）後面，讓核心可以搬到別的主機。只有 `src/deps.ts`、Blob store 轉接層與 sharp 縮圖器會匯入 Vercel 或 sharp 專屬的套件。

## 平台限制

- Claude 桌面版沒有直接的「儲存圖片」，Copy Image 也無效。請從結果中複製圖片網址，在瀏覽器中開啟。
- 桌面版無法解碼 DNG 照片，HEIC 可能也不行。請先匯出成 JPEG。iOS 會自動轉換這兩種格式。
- 更換已上傳的照片後，請等約一分鐘再要求編輯，否則可能仍會用到先前的照片。更換之後，widget 也會顯示同樣的提示（「約一分鐘後 Claude 才能使用新照片。」）。
- Android 尚未測試。

## 移除部署

請在已連結的 clone 中執行 `vercel blob` 指令。執行 `npx vercel link` 之後，`.env.local` 有 `VERCEL_OIDC_TOKEN` 但沒有 `BLOB_STORE_ID`，在你刪除 `VERCEL_OIDC_TOKEN` 那一行或傳入對應參數（`--rw-token`，或 `--oidc-token` 搭配 `--store-id`）之前，這些指令都會失敗；見[開發](#開發)。

1. 清空已連結專案的 store：`npx vercel blob empty-store`。
2. 用 `npx vercel blob list-stores --all` 找到 store id（形如 `store_...`），再用 `npx vercel blob delete-store <store id>` 刪除 store。這個指令沒有 `--yes`，而且會拒絕刪除非空的 store。
3. 移除專案：`npx vercel project remove <name>`。
4. 在 claude.ai 移除連接器。

## 授權

[MIT](LICENSE)
