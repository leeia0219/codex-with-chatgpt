# Codex with ChatGPT · camera-relate-v3

这是 [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt) 的个人维护分支，服务于 `camera_relate` 项目，也可以安装到其他本地 Git 工作区。

原版让 ChatGPT 通过只读连接读取 Codex 的本地工作区，并负责规划和复核；Codex 负责修改文件、运行命令和测试。v3 保留这套分工，增加了 **GitHub 已提交内容的只读读取能力**，并记录了我们在 Windows、ChatGPT Project 和 Cloudflare 固定域名环境中实际遇到的问题。

## v3 相对原版修改了什么

### 1. 增加 GitHub 只读工具

新增三个工具：

- `github_repository`：确认远端仓库、默认分支和认证状态；
- `github_list_directory`：列出 GitHub 仓库目录；
- `github_read_file`：读取已经 commit 并 push 的文件。

仓库默认从当前工作区的 `origin` 自动识别，也可通过 `.c2c.json` 指定 `githubRepository` 和 `githubDefaultRef`。公开仓库不需要凭据；私有仓库可以使用本机已有的 GitHub SSH 权限，或服务端只读 token。

### 2. 区分本地状态和 GitHub 状态

v3 不把两种来源混在一起：

| 来源 | 代表什么 |
|---|---|
| Workspace 工具 | 当前本地文件、未提交修改、git diff、测试和执行记录 |
| GitHub 工具 | 已经 commit 并 push 到远端的内容 |

两边不一致时，本地 Workspace 是当前开发状态；GitHub 只用于查看远端版本。ChatGPT 不应为了同一个问题重复读取两边的同一文件。

### 3. 更新 C2C Skill

Skill 会告诉 ChatGPT：

- 只能读取与当前工作区匹配的 GitHub 仓库；
- 私有仓库认证失败时继续使用本地 Workspace；
- 不把 GitHub token、文件正文、diff 或长日志粘贴到聊天；
- 自定义 v3 不自动切换或合并 `upstream/main`，避免更新时覆盖 v3 的 GitHub 支持。

### 4. 增加测试

新增 GitHub client 和 MCP 集成测试，覆盖公开仓库、私有仓库认证、路径限制、目录读取、文件读取以及本地/远端来源边界。

### 5. 补充 Cloudflare 固定连接经验

固定域名能力来自原版；v3 新增的是我们实际使用后的说明和跨电脑注意事项。详见 [docs/cloudflare-named-connection.md](docs/cloudflare-named-connection.md)。

## 简单安装（Windows）

需要：Git、Node.js 20+、pnpm、cloudflared，以及 Codex 桌面版。

```powershell
git clone --branch camera-relate-v3 https://github.com/leeia0219/codex-with-chatgpt `
  "$HOME\codex-with-chatgpt"
Set-Location "$HOME\codex-with-chatgpt"
pnpm install
pnpm build

New-Item -ItemType Directory -Force "$HOME\.codex\skills\codex-with-chatgpt"
Copy-Item .\skill\SKILL.md "$HOME\.codex\skills\codex-with-chatgpt\SKILL.md" -Force
```

打开安装后的 `SKILL.md`，把下面这一行改为本机真实路径：

```text
The codex-with-chatgpt checkout lives at: `C:/Users/<用户名>/codex-with-chatgpt`
```

然后在需要连接的 Codex 工作区中发送：

```text
Set up Codex with ChatGPT for this workspace using the Codex with ChatGPT skill.
```

Codex 会继续完成本地启动、ChatGPT App 配置、配对和工作区读取验证。需要用户亲自处理的通常只有登录、验证码、2FA 和 Cloudflare 授权。

## 实际使用方式

一个工作区只使用：

- 一个 ChatGPT Project；
- 一个名称明确的 App，例如 `Codex with ChatGPT · camera_relate-v3`；
- 一条 C2C 本地连接。

在 ChatGPT Project 中新建 **Chat** 对话，在输入框选择准确的 C2C App，然后调用 `workspace_info`。返回的工作区名称、Git 分支和 HEAD 正确后才开始任务。

之后可以直接对 Codex 说：

```text
使用 Codex with ChatGPT 完成这个任务：……
```

ChatGPT 读取代码并给出计划，Codex 执行，随后 ChatGPT 再读取真实 diff 和测试记录进行复核。

## 我们实际踩过的坑

### App 和 Plugin 看起来像两个

ChatGPT 聊天里称为 **App**，管理页面地址和内部 ID 仍可能包含 `plugins` 或 `plugin_asdk_app`。它们通常是同一个对象的使用入口和管理入口。管理页中同名记录只有一条，就不是安装了两个。

### 旧对话显示 App unavailable

删除并重建 App 后，旧对话可能仍缓存旧 App 身份。管理页即使显示 Connected，旧对话仍可能提示 unavailable。

处理方法：在同一个 ChatGPT Project 中新建 **Chat** 对话，重新选择当前 App，调用 `workspace_info` 验证。不要反复创建多个不同名字的副本。

### Chat 与 Work 不是同一个对话模式

新 C2C 对话应使用 **Chat**。我们曾在 Work 模式测试成功读取，但它不适合作为 Skill 保存和复用的标准会话。建立新对话时要先确认模式。

### GitHub 已绑定，不代表本地桥能使用 GitHub 凭据

ChatGPT 自己安装的 GitHub App 凭据不能被本地 C2C 读取或转用。私有仓库出现 `GITHUB_NOT_FOUND_OR_UNAUTHORIZED` 时，需要在运行 C2C 的电脑上配置 GitHub SSH 权限或只读 token。只想读取当前本地项目时，继续使用 Workspace 即可。

### Git push 不会迁移 Cloudflare 连接

Cloudflare 登录、tunnel credential、配对状态和会话数据都保存在 Git 仓库之外。另一台电脑 clone 代码后必须重新授权和配置。

两台电脑同时运行时建议使用不同 hostname：

```text
c2c-<workspace>-desktop.example.com
c2c-<workspace>-laptop.example.com
```

真实域名、tunnel ID、token、凭据 JSON、PEM、PFX、配对码和 cookie 都不应提交到 Git。经验可以公开，凭据不可以。

### 临时地址与固定域名

临时地址在进程或电脑重启后可能改变，ChatGPT 端需要删除旧连接并按新地址重建。固定域名通常可以跨重启复用；若 Cloudflare 授权失效，应重新登录并运行 doctor，不要先删除 ChatGPT App。

如果当前网络会丢弃 Cloudflare 的 QUIC 连接，可在启动 C2C 前设置 `C2C_TUNNEL_PROTOCOL=http2`，然后重启 Bridge。未设置时继续使用 cloudflared 的默认传输方式。

### 为什么 v3 不自动更新

这个分支含有原版没有的 GitHub 支持。自动拉取 `upstream/main` 可能覆盖这些修改，所以 v3 Skill 已删除自动检查和自动更新流程。需要同步上游时，维护者应先比较差异，再手工合并到 `camera-relate-v3` 并运行测试。

## 凭据和 Git 边界

下面内容必须留在本机：

- Cloudflare 登录文件和 tunnel credentials；
- GitHub token、OAuth token 和配对码；
- `.env`、SSH 私钥、PEM、PFX 和 cookie；
- C2C runtime、session、日志和授权状态。

C2C 的运行状态位于系统应用数据目录，不在项目仓库中。知道公网地址本身也不能读取工作区：请求仍需经过授权，并且令牌绑定具体工作区。

## 故障检查

```powershell
node .\bin\c2c.js doctor -w "C:\path\to\workspace" --json
```

先确认本地服务、工作区、授权和公网连接均正常，再进入 ChatGPT 对话测试。验证命令是 `workspace_info`，不是只看管理页的 Connected 状态。

## 开发验证

```powershell
pnpm install
pnpm build
pnpm test
```

更多资料：[架构](docs/architecture.md) · [安全](docs/security.md) · [协议](docs/protocol.md) · [故障排查](docs/troubleshooting.md)

## 上游与许可证

- 上游项目：<https://github.com/XiaoDuoYa/codex-with-chatgpt>
- v3 仓库：<https://github.com/leeia0219/codex-with-chatgpt>
- 许可证：[MIT](LICENSE)

这是非官方社区分支，与 OpenAI、Microsoft 或 Cloudflare 无关联，也未获其背书。
