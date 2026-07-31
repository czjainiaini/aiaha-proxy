# aiaha-proxy

> 一个零依赖的本地 **OpenAI 兼容反向代理**，把「风月 / aiaha」这类基于 Dify 的角色站点的对话接口，转换成标准的 `/v1/chat/completions`，供 **SillyTavern（酒馆）** 等本地客户端直接调用；并附带一个实时**监控面板**。
>
> A zero-dependency local **OpenAI-compatible reverse proxy** that exposes a Dify-based character site's chat API as a standard `/v1/chat/completions` endpoint for SillyTavern and other local clients, with a built-in real-time monitoring dashboard.

---

## ⚠️ 免责声明 / Disclaimer

- 本项目仅供 **学习研究与个人使用**。是否使用、如何使用，由你自行判断并承担全部风险。
- 使用本工具调用第三方站点接口，**可能违反该站点的服务条款，并存在账号被封禁的风险**。推理仍在对方服务器进行，**消耗的是你自己账号的额度/积分**。
- 本项目与任何第三方平台**无隶属关系**，不提供、不代售任何账号或额度。
- 你的账号信息（token / 邮箱 / 密码）**只保存在你本机**，仅用于向该平台的官方接口登录续期，不会发送到任何其它位置。

---

## ✨ 功能特性

- **OpenAI 兼容**：`/v1/chat/completions`（流式 + 非流式）、`/v1/models`。
- **全量模型**：实时拉取站点全部模型，带 **状态（通畅/拥挤/异常）+ 成功率 + 价格**，在客户端下拉框直接选择；所选模型不可用时**自动回退**到可用渠道。
- **纯 API 模式**：使用一个**空白 App**作为纯模型通道，人设 / 世界书 / 预设完全由你本地客户端控制，无服务器端人设污染。
- **自动登录续期**：token 过期或不足 2 天时，用邮箱密码**自动登录**换取新 token，免手动维护。
- **多域名容灾**：主域名不可用时自动切换到镜像域名。
- **实时监控面板** `/dashboard`：服务状态、积分余额趋势、模型状态分布、Top 成功率、请求流量，3 秒自动刷新；内置**网页设置**（填写账号/App/模型/开关并保存）。
- **零依赖**：仅需 Node.js，无需 `npm install`，前端为单文件 HTML + 原生 SVG/CSS 图表。

---

## 🚀 快速开始

### 1. 前置条件
- 安装 [Node.js](https://nodejs.org/) 18+（推荐 20/22+，需支持原生 `fetch`）。
- 在目标站点拥有账号，并**创建一个空白角色（App）**——人设、世界书、开场白全部留空——记下它的 `app_id`（用作纯模型通道）。

### 2. 获取与配置
```bash
git clone <your-repo-url>
cd aiaha-proxy
```
- 首次运行会自动从 `config.example.json` 生成 `config.json`；或手动复制：
  `copy config.example.json config.json`（Windows）/ `cp config.example.json config.json`。
- 在 `config.json` 或**监控面板的「⚙ 设置」**里填写：
  - `app_id`：你的空白 App ID
  - `email` / `password`：站点账号（用于自动续期，可选）
  - `domains`：站点主域名及镜像

### 3. 启动
```bash
node server.js
```
启动后：
- 监控面板：`http://127.0.0.1:8787/dashboard`（默认自动打开）
- OpenAI 兼容地址：`http://127.0.0.1:8787/v1`

Windows 用户也可双击 `aiaha.bat` 使用菜单式启动器（启动 / 设置 / 刷新令牌）。

### 4. 在 SillyTavern 接入
- API 类型：Chat Completion → **Custom（OpenAI-compatible）**
- 端点 URL：`http://127.0.0.1:8787/v1`
- API Key：留空（或与 `config.json` 的 `local_api_key` 一致）
- 连接后在「可用模型」下拉框选择即可。

---

## ⚙️ 配置项（`config.json`）

| 字段 | 说明 |
| --- | --- |
| `console_token` | 登录令牌（自动登录会自动写入；也可手动填） |
| `email` / `password` | 账号，用于 token 自动续期（**敏感，勿提交**） |
| `auto_login` | token 将过期时是否自动登录续期 |
| `app_id` | 空白 App 的 ID（纯模型通道） |
| `domains` | 站点主域名 + 镜像（容灾） |
| `model` / `fallback_models` | 默认模型与回退链 |
| `port` | 本地监听端口（默认 8787，仅 `127.0.0.1`） |
| `local_api_key` | 客户端访问本代理的密钥；留空则本机免密 |
| `strip_reasoning` | 是否去除 `<details>` 思维链块 |
| `model_id_style` | `verbose`（含状态/成功率）或 `plain` |
| `hide_abnormal` | 是否在模型列表隐藏「异常」模型 |
| `open_browser` | 启动后是否自动打开监控面板 |

---

## 🎴 角色卡链接：获取与设置

代理通过一个「角色卡（App）」作为对话通道。可在**监控面板 → ⚙ 设置 → 角色卡链接 / App ID** 中填写，或直接改 `config.json` 的 `app_id`。支持两种输入：

- **完整链接**：如 `https://aiaha.xyz/zh/explore/installed/<UUID>`
- **纯 App ID（UUID）**：如 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

程序会自动从链接中提取 UUID。填写后点「验证角色卡」可确认是否有效；保存后**当前会话即时生效**（无需重启），并写入 `config.json` 供下次启动。

### 如何获取链接
1. 登录站点，打开任意角色卡页面。
2. 复制浏览器地址栏的 URL（形如 `.../explore/installed/<UUID>`）粘贴进来即可。

### 两类卡的区别与选择
| 类型 | 如何获得 | 效果 | 适用场景 |
| --- | --- | --- | --- |
| **空白卡**（推荐） | 在站点「创作」新建角色，人设 / 世界书 / 开场白**全部留空** | 纯 API：只把你**酒馆本地**的提示词发给模型，无服务器端人设污染 | 用自己的角色卡 / 预设 / 世界书 |
| **完整设定卡** | 任意已发布角色卡的链接 | 会**叠加**该卡在服务器端的隐藏人设与「思维链」格式 | 想直接体验某张卡的设定 |

> 提示：空白卡的人设为空，模型行为完全由酒馆控制；完整设定卡的人设由作者锁定、无法在本地清除。

---

## 🔐 安全说明

- 代理仅监听 `127.0.0.1`，**只允许本机访问**。
- `config.json`、`config.json.bak` 已在 `.gitignore` 中排除，**不会被提交**；仓库仅包含无敏感信息的 `config.example.json`。
- token 与 `local_api_key` 与密码同等敏感——请勿分享 `config.json`。

---

## 🧩 项目结构

```
aiaha-proxy/
├─ server.js            # 代理主程序（OpenAI 兼容 / 模型 / 自动登录 / 面板接口）
├─ dashboard.html       # 监控面板（含网页设置）
├─ setup-account.js     # 命令行账号设置向导（可选）
├─ refresh-token.js     # 手动刷新 token 工具（可选）
├─ config.example.json  # 配置模板（无敏感信息）
├─ aiaha.bat            # Windows 菜单式启动器
└─ .gitignore
```

---

## 🙏 致谢

设计与思路参考了社区中同类的开源项目（如 Dify 的接口规范、酒馆生态工具等）。本项目以 MIT 协议开源。

## 📄 License

[MIT](./LICENSE)
