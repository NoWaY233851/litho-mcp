# litho-mcp
[![CI](https://github.com/NoWaY233851/litho-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/NoWaY233851/litho-mcp/actions/workflows/ci.yml?query=branch%3Amain)

[English](README.md) | [繁體中文](README.zh-TW.md) | 简体中文

> 本文译自英文版 [README.md](README.md)。两者内容不一致时，以英文版为准。

litho-mcp 是一个在 Vercel 上以单个 Node.js 函数运行的远程 [MCP](https://modelcontextprotocol.io) 服务器。把它作为自定义连接器添加到 claude.ai 后，Claude 就能在对话中通过 [OpenRouter](https://openrouter.ai) 生成和编辑图片，结果直接显示在对话里。它的设计已在 claude.ai 网页版、Claude 桌面版和 Claude iOS App 上验证过。

每个部署只服务一个人：部署它的那个人。没有数据库，也没有登录流程。连接器通过一个放在请求头中的共享密钥进行认证。

工具：

- `generate_image`：根据文本提示词生成图片，可使用任何 OpenRouter 图片模型。
- `edit_image`：编辑图片，或以参考图片生成新图。参考图可以是本服务器生成的图片、你上传的照片，或公开的 http(s) URL。
- `upload_image`：在对话中显示上传按钮，让你从设备中选择照片。
- `list_models`：列出 OpenRouter 的图片模型，以及每个模型支持的参数。

设计内容、被否决的备选方案及理由，都记录在 [docs/design/](docs/design/README.md)（英文）。

## 前提条件

- 一个在自定义连接器中有 **Request headers**（请求头）选项的 claude.ai 账号。该功能目前处于测试阶段，开放范围有限。没有它，litho-mcp 无法完成认证，也就无法使用（见 [ADR 0009](docs/design/0009-connector-secret-header.md)）。
- 一个 Hobby 方案的 Vercel 账号。
- 一个设置了**消费上限**的 [OpenRouter](https://openrouter.ai) API 密钥：在 OpenRouter 控制台创建密钥，并为它设置额度上限。服务器本身从不限制模型花费，所以密钥上的额度就是你花费的上限。
- 用来部署的电脑上需要 Node.js 22.19 或更高版本。

## 部署

所有命令都在本仓库的克隆中运行。如果你的 CLI 版本不同，请用 `npx vercel <command> --help` 核对参数；以下命令于 2026-10-18 用 Vercel CLI 64.5.0 核对过。

1. 登录，并创建和关联项目：

   ```
   npm install
   npx vercel login
   npx vercel project create <name>
   npx vercel link --yes --project <name>
   ```

   直接运行 `npx vercel link` 也可以，它会以交互方式逐项询问。

2. 创建一个**公开（Public）**的 Blob store。它用来存放图片，图片直接通过 Blob URL 提供（见 [ADR 0010](docs/design/0010-vercel-blob-storage.md)）。推荐的做法是使用 Vercel 控制台（以下标签为 2026-10-19 的版本，之后可能会变）：

   1. 在 Vercel 控制台中选择 **Create Blob Store**，访问权限设为 **Public**。
   2. 把 store 连接到项目的 Production 和 Preview 环境。
   3. 不要勾选 **Add a read-write token env var to this connection**。

   连接后会添加 `BLOB_STORE_ID`（以及服务器用不到的 `BLOB_WEBHOOK_PUBLIC_KEY`），但不会添加 token。函数之后会用 Vercel 附加在每次调用上的 OIDC token 访问 Blob，所以项目中没有长期有效的 Blob 密钥。Cron 调用同样会拿到这个 token，所以每日清理也以相同方式运行。

   另一种受支持的做法是使用 CLI：

   ```
   npx vercel blob create-store <name> --access public --yes
   ```

   加上 `--yes` 时，store 会连接到 Production、Preview 和 Development，CLI 还会在这三个环境中把 `BLOB_READ_WRITE_TOKEN` 设为普通（Config）变量。它不会设置 `BLOB_STORE_ID`；服务器会从 token 推导出 store id。这样可以正常工作，代价是这个能写入并删除所有图片的 token，在控制台和 `npx vercel env pull` 中都能读到。

   两者同时存在时，以 token 为准。如果在 CLI 设置之后想改用 OIDC，请删除 `BLOB_READ_WRITE_TOKEN`，并确认已设置 `BLOB_STORE_ID`。

3. 生成两个密钥。每个至少 32 个字符，太短的话服务器会拒绝提供服务：

   ```
   CONNECTOR_SECRET=$(openssl rand -base64 32)
   CRON_SECRET=$(openssl rand -base64 32)
   ```

   现在就把 `CONNECTOR_SECRET` 的值保存到密码管理器中（在 macOS 上可以用 `printf %s "$CONNECTOR_SECRET" | pbcopy` 复制）。以 sensitive 变量存入 Vercel 后就无法再读回，而配置连接器请求头时还要用到它。在下一步完成前，请保持这个 shell 会话不要关闭，或者改用保存下来的值。

4. 添加 [.env.example](.env.example) 中的变量。应用密钥只放在 **production**：单人使用的部署在 Preview 或 Development 中都用不到它们，复制过去只会扩大暴露面。因此 Preview 部署会返回 `500` 和 `server_misconfigured`，这是预期的结果。本地运行时读取按 `.env.example` 填写的 `.env.local`，该文件已被 gitignore，也从不上传。请通过 stdin 传入密钥，不要用 `--value`，以免留在 shell 历史记录中：

   ```
   printf %s "$CONNECTOR_SECRET" | npx vercel env add CONNECTOR_SECRET production --sensitive
   printf %s "$CRON_SECRET" | npx vercel env add CRON_SECRET production --sensitive
   npx vercel env add OPENROUTER_API_KEY production --sensitive
   ```

   最后一条命令会提示你输入密钥。可选的普通变量：

   ```
   npx vercel env add RETENTION_DAYS production --value 30 --no-sensitive --yes
   npx vercel env add DEFAULT_MODEL production --value <model id> --no-sensitive --yes
   ```

   | 变量 | 必填 | 说明 |
   |---|---|---|
   | `OPENROUTER_API_KEY` | 是 | 所有图片请求使用的 OpenRouter 密钥。 |
   | `CONNECTOR_SECRET` | 是 | claude.ai 在 `Authorization` 请求头中发送的密钥。至少 32 个字符。 |
   | `CRON_SECRET` | 是 | Vercel Cron 发送给清理路由的密钥。至少 32 个字符。 |
   | `BLOB_READ_WRITE_TOKEN` | 二选一 | store 的读写 token，由 CLI 方式以普通变量写入。设置后，所有 Blob 调用都使用它。 |
   | `BLOB_STORE_ID` | 二选一 | store id，可以带或不带 `store_` 前缀。没有 token 时必填，此时函数使用平台的 OIDC token。有 token 时可省略；如果设置，会取代 token 内的 id 来确定公开 URL 的基础地址。 |
   | `DEFAULT_MODEL` | 否 | 调用未指定模型时使用的模型。留空则使用内置默认值。 |
   | `RETENTION_DAYS` | 否 | 图片保留的天数。留空表示 30 天。 |
   | `OPENROUTER_REFERER` | 否 | 发送给 OpenRouter 的 `HTTP-Referer`。留空则不发送。 |

   缺少必填变量、必填变量强度不够，或者两个 Blob 变量都没有，服务器都会返回 `500` 和 `server_misconfigured`。日志只会写出变量名，从不写出它的值。

5. 部署：

   ```
   npx vercel --prod
   ```

   这条命令会输出两个 URL。请使用标为 `Aliased` 的那个：它是项目的生产域名，本文用 `<project>.vercel.app` 指代它。标为 `Production` 的是这一次部署自己的 URL，它处于 Vercel 的部署保护之后，会返回 `302`，所以不要把它用于连接器或下面的检查。

6. 确认端点会拒绝未认证的请求：

   ```
   curl -i -X POST https://<project>.vercel.app/mcp
   ```

   响应必须是 `401` 和 `{"error":"unauthorized"}`。

   这项检查不会访问 Blob。下一节有第二项会访问 Blob 的检查。

## 在 claude.ai 中添加连接器

1. 打开 **Customize > Connectors**，添加一个自定义连接器。
2. URL：`https://<project>.vercel.app/mcp`。
3. 认证方式：**No sign-in**（不使用 OAuth）。claude.ai 会对这个选项显示警告，这是预期的：下一步的请求头就是认证方式。
4. 请求头：名称 `Authorization`，值 `Bearer <CONNECTOR_SECRET>`。
5. 第一次请在 claude.ai 网页版或桌面版中添加，带请求头的对话框在那里最容易操作。对话框显示请求头的值时，不要截图或分享。

添加会直接完成，不会出现“Continue anyway”步骤。添加过程中，claude.ai 会发送一个不带请求头的 `initialize` 请求并收到 `401`，还会在 `/.well-known/` 下查找 OAuth 元数据并收到 Vercel 的静态 `404`。两者都是预期的。在 Vercel 的请求日志中，前者只显示为一条 `401`，服务器本身不会为它写任何日志。

### 首次测试：上传照片

在任何生成之前，先让 Claude 调用 `upload_image`，然后在 widget 中任选一张照片。推荐把它作为首次测试，因为它不花钱：不会发出任何 OpenRouter 请求。widget 显示照片已上传，就说明 Blob token、store id，以及由它们推导出的公开图片 URL 都端到端正常工作。否则，错误的 Blob 基础地址（错误的 `BLOB_STORE_ID`，或 token 中无法使用的 store id）要到第一次付费的 `generate_image` 时才会暴露：在模型已经计费之后，才以“could not be saved”失败。

如果 widget 报告照片无法上传，说明服务器返回了“The photo could not be saved. Try uploading it again.”，并在该部署的 Vercel 日志中记下原因 `upload save failed: <reason>`。原因是以下之一：

- `blob base URL mismatch`：Blob 接受了写入，但它返回的 URL 与服务器从 `BLOB_STORE_ID` 或 token 推导出的 URL 不一致。请修正或删除 `BLOB_STORE_ID`，重新部署后再试。
- Blob SDK 的错误，例如 token 无效或已被吊销：请检查 `BLOB_READ_WRITE_TOKEN`。没有 token 时，请确认 store 已连接到你正在测试的环境。

如果 claude.ai 报告“Connection issue”，说服务器要求登录（状态 401），说明请求头的值错误或缺失。

### 使用方法

claude.ai 有自己制作可视化内容的方式，遇到“画一张菜谱卡”这类请求时，可能会改用它们。在一段对话中第一次使用时，请点名连接器，例如“用 litho-mcp 生成一张菜谱卡”，或者明确要求一张图片，例如“生成一张菜谱卡的图片”。litho-mcp 在一段对话中用过一次之后，Claude 在这段对话中就会继续使用它。

## 轮换密钥

1. 生成新值并保存到密码管理器中：

   ```
   CONNECTOR_SECRET=$(openssl rand -base64 32)
   printf %s "$CONNECTOR_SECRET" | pbcopy   # macOS；其他系统请手动复制
   ```

2. 替换这个变量。不要在 `CONNECTOR_SECRET` 为空时运行，否则服务器会拒绝提供服务。

   ```
   printf %s "$CONNECTOR_SECRET" | npx vercel env add CONNECTOR_SECRET production --sensitive --force
   ```

3. 用 `npx vercel --prod` 重新部署。旧的连接器会立即失效，claude.ai 会显示“This connector's stored credential was rejected”。这条消息指的是连接器密钥，不是 OpenRouter 密钥。
4. 在 claude.ai 中删除连接器，再用新的请求头值重新添加。已有连接器的请求头无法编辑。

`env add --force` 可以替换任何变量，所以 `CRON_SECRET` 和 `OPENROUTER_API_KEY` 也以相同方式轮换（OpenRouter 密钥请先在它的控制台创建新的）。轮换 `CRON_SECRET` 不需要改动连接器。

## 保留期限

图片会在创建 `RETENTION_DAYS` 天后删除（默认 30 天）。清理由每天运行一次的 Vercel Cron 任务负责，时间大约在 UTC 03:00（见 `vercel.json`；Hobby 的 cron 时间只精确到小时），所以图片最多可能比设置多保留约一天。修改 `RETENTION_DAYS` 需要重新部署后才会生效。

## 限制

- 超出 Vercel Hobby 或 Blob 的配额，服务会暂停最多 30 天。Hobby 和 Blob 不会对超额部分收费。
- Hobby 方案仅限非商业用途。
- 模型费用由 OpenRouter 计费，上限只取决于你在密钥上设置的额度。

## 安全说明

报告漏洞请按照 [SECURITY.md](SECURITY.md)（英文）操作，不要提交公开的 issue。

- 图片链接是 capability URL：Blob store 是公开的，任何持有链接的人都能查看那张图片。链接无法猜测，也不会在任何地方列出，但请把它们当作共享的机密对待。图片会在保留期限过后删除。
- Vercel Blob 会把每一次下载都计入 Hobby 的数据传输配额，缓存命中也算：每月 10 GB（2026-10-18 于 <https://vercel.com/docs/vercel-blob/usage-and-pricing> 核对，该页面更新于 2026-09-23）。超出会使 Blob 访问暂停最多 30 天，所以一个被广泛分享的链接可能导致整个部署暂停。
- 要撤销一张泄露的图片，运行 `npx vercel blob del <url>`（参数用 Vercel CLI 64.5.0 核对过；另见[开发](#开发)中关于 `--oidc-token` 的说明）。由于 CDN 传播需要时间，图片在删除后最多约 60 秒内仍可能被访问。
- 使用 OIDC 时，项目不持有任何 Blob 密钥。使用 `BLOB_READ_WRITE_TOKEN` 时，任何能读取项目变量的人都能写入并删除所有图片。
- `CONNECTOR_SECRET` 是长期有效的 bearer 密钥。任何持有它的人，都能通过本服务器使用你的 OpenRouter 密钥。它以恒定时间进行比较，错误的密钥和缺失的密钥得到的响应相同。
- 没有 OAuth，也没有按会话的登录。轮换需要手动进行（见上文）。
- 传给 `edit_image` 的 URL，由服务器在通过 SSRF 检查后才去获取（见 [ADR 0007](docs/design/0007-reference-urls-ssrf.md)）。
- `npx vercel link` 和 `npx vercel env pull` 会把真实的 token 写入 `.env.local`。匹配 `.env*` 的文件都已被 gitignore，`.vercelignore` 中的白名单也会把它们排除在部署上传之外。不要把它们复制到别处。
- `public/robots.txt` 禁止爬虫抓取这个部署。
- 服务器从不记录请求或响应的内容、密钥或 token。

## 开发

```
npm test            # 构建 widget，然后运行 vitest
npm run typecheck   # 服务器和 widget 的 TypeScript 类型检查
npm run hygiene     # 扫描已跟踪的文件中是否有个人信息
npx vercel dev      # 在本地运行函数（需要环境变量）
```

测试从不联网。每次 commit 前都要运行 `npm run hygiene`。

`npx vercel link` 会在 `.env.local` 中写入 `BLOB_READ_WRITE_TOKEN` 和 `VERCEL_OIDC_TOKEN`，但不会写入 `BLOB_STORE_ID`。在 Vercel CLI 64.5.0 下，`npx vercel blob` 命令随后会失败，提示“VERCEL_OIDC_TOKEN and BLOB_STORE_ID must both be set, or both be unset”。请删除 `VERCEL_OIDC_TOKEN` 这一行，或者传入对应的参数（`--rw-token`，或 `--oidc-token` 加 `--store-id`）。如果你的 CLI 版本不同，请核对当前的行为。

与托管平台相关的代码都放在小型适配层（adapter）之后，使核心代码可以迁移到其他平台。只有 `src/deps.ts`、Blob store 适配层和 sharp 缩略图生成器会导入 Vercel 或 sharp 专属的包。

## 平台限制

- Claude 桌面版没有直接的“保存图片”，Copy Image 也不起作用。请从结果中复制图片地址，在浏览器中打开。
- 桌面版无法解码 DNG 照片，HEIC 可能也不行。请先导出为 JPEG。iOS 会自动转换这两种格式。
- 更换已上传的照片后，请等大约一分钟再要求编辑，否则可能仍会用到之前的照片。更换之后，widget 也会显示同样的提示（“大约一分钟后 Claude 才能使用新照片。”）。
- 尚未在 Android 上测试。

## 删除部署

请在已关联的克隆中运行 `vercel blob` 命令。运行 `npx vercel link` 之后，`.env.local` 中有 `VERCEL_OIDC_TOKEN` 但没有 `BLOB_STORE_ID`，在你删除 `VERCEL_OIDC_TOKEN` 这一行或传入对应参数（`--rw-token`，或 `--oidc-token` 加 `--store-id`）之前，这些命令都会失败；见[开发](#开发)。

1. 清空已关联项目的 store：`npx vercel blob empty-store`。
2. 用 `npx vercel blob list-stores --all` 找到 store id（形如 `store_...`），再用 `npx vercel blob delete-store <store id>` 删除 store。这条命令没有 `--yes`，而且会拒绝删除非空的 store。
3. 删除项目：`npx vercel project remove <name>`。
4. 在 claude.ai 中删除连接器。

## 许可证

[MIT](LICENSE)
