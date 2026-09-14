# Codex with ChatGPT · 实际使用版

> ChatGPT 负责规划和复核，Codex 负责改文件、运行命令和测试。

这是我们在 Windows、ChatGPT Project、固定 Cloudflare 域名和 GitHub 仓库环境中实际跑通的 v3 工作流。它不会把整个仓库上传到 ChatGPT。ChatGPT 通过每个工作区自己的只读 App 按需读取文件、Git 状态、diff 和测试记录；Codex 始终保留执行权。

## 已验证的使用方式

- 一个本地工作区对应一个 ChatGPT Project 和一个 C2C App。
- App 名称形如 `Codex with ChatGPT · <workspace>`。
- 新对话必须在对应 Project 中建立，并在输入框选择该 App。
- 本地未提交文件以 Workspace 读取为准；GitHub 读取只代表已经 push 的内容。
- 固定域名适合长期连接；临时地址重启后可能变化。
- Cloudflare、授权和会话凭据保存在系统应用数据目录，不进入 Git。
- ChatGPT 只规划和复核；写文件、Shell、Git 和测试全部由 Codex 完成。

## 在另一台 Windows 电脑安装 v3

最简单的方法是把下面整段交给 Codex：

```text
请安装并配置 Codex with ChatGPT camera-relate-v3：

1. 检查并安装 Git、Node.js 20+、pnpm 和 cloudflared。
2. 克隆 https://github.com/leeia0219/codex-with-chatgpt 到
   C:\Users\<用户名>\codex-with-chatgpt，并 checkout camera-relate-v3 分支。
3. 执行 pnpm install 和 pnpm build。
4. 把 skill/SKILL.md 安装到
   C:\Users\<用户名>\.codex\skills\codex-with-chatgpt\SKILL.md，
   并把其中 checkout 路径改成本机实际路径。
5. 对当前工作区执行 c2c sandbox-allow 和首次 setup。
6. 只使用 Codex 内置浏览器配置 ChatGPT；只有登录、验证码、2FA 或
   Cloudflare 授权需要我操作，而且一次只告诉我一个动作。
7. 一个工作区只建立一个 App。创建 ChatGPT Project，名称使用工作区名，
   记忆选择“仅限项目记忆”。
8. 最后调用 workspace_info，并确认返回的工作区、分支和 HEAD 正确。
```

手动安装命令：

```powershell
git clone --branch camera-relate-v3 https://github.com/leeia0219/codex-with-chatgpt `
  "$HOME\codex-with-chatgpt"
Set-Location "$HOME\codex-with-chatgpt"
pnpm install
pnpm build
New-Item -ItemType Directory -Force "$HOME\.codex\skills\codex-with-chatgpt"
Copy-Item .\skill\SKILL.md "$HOME\.codex\skills\codex-with-chatgpt\SKILL.md" -Force
```

安装 Skill 后，让 Codex 执行：

```text
Set up Codex with ChatGPT for this workspace using the Codex with ChatGPT skill.
```

## 首次连接的实际流程

1. C2C 检测当前 Git 工作区。
2. 选择临时地址或固定域名。
3. 在 ChatGPT 管理页创建一个与工作区同名的 App。
4. 完成一次配对。
5. 在 ChatGPT 创建对应 Project，记忆选择“仅限项目记忆”。
6. 在 Project 的新 **Chat** 对话中，从输入框选择准确的 C2C App。
7. 调用 `workspace_info` 验证工作区名称、分支、HEAD 和 dirty 状态。

如果旧对话提示 App unavailable，而管理页显示连接正常，通常是旧对话缓存了已经删除的 App 身份。在同一个 Project 中新建 Chat 对话、重新选择当前 App，再执行 `workspace_info`。不要为了测试连续建立多个同名 App。

## App 和 Plugin 是不是两个

不是。ChatGPT 当前把聊天中使用的能力称为 **App**，管理页地址和部分内部 ID 仍包含 `plugins` 或 `plugin_asdk_app`。这通常只是界面和内部命名：

- 聊天输入框里选择的是 App；
- `/plugins` 页面用于管理它；
- 同名 App 在管理页只有一条记录时，就只有一个连接。

每个工作区应只保留一个准确名称的 App。旧地址失效时，删除该工作区的旧 App 后用同一个名称重建，不要创建 `-new`、`-v4` 等重复副本。

## 固定域名与 Git 安全

Git 仓库只保存通用实现和脱敏说明。以下内容不得提交：

- Cloudflare 登录证书和 tunnel credential JSON；
- API token、tunnel token、OAuth token、配对码和 cookie；
- `.env`、PFX、PEM、私钥和运行日志；
- 不希望公开的真实域名、hostname 和 tunnel ID。

C2C 运行状态位于操作系统应用数据目录，Cloudflared 凭据也位于仓库外。因此普通 `git clone`、`git pull` 和 `git push` 不会迁移连接权限。

另一台电脑应重新登录 Cloudflare。两台电脑需要同时在线时，为每台机器使用独立 hostname，例如：

```text
c2c-<workspace>-desktop.example.com
c2c-<workspace>-laptop.example.com
```

更完整的脱敏经验见 [固定 Cloudflare 连接说明](docs/cloudflare-named-connection.md)。

## 本地工作区与 GitHub

v3 可同时提供两类只读数据：

| 来源 | 适合读取 | 不包含 |
|---|---|---|
| Workspace | 当前文件、未提交修改、git diff、测试记录 | 工作区之外的文件 |
| GitHub | 已提交并 push 的仓库内容 | 本地未提交修改 |

公开仓库无需 GitHub 凭据。私有仓库可使用本机已有的 GitHub SSH 权限，或只读 fine-grained token。Token 只能放在服务端环境变量中，不能写进仓库、ChatGPT Project 指令或聊天内容。

如果目标只是让 ChatGPT 查看当前开发状态，优先使用 Workspace。只有需要比较远端已 push 内容时才使用 GitHub，避免把同一文件从两边重复读取。

## 日常使用

给 Codex 的请求示例：

```text
使用 Codex with ChatGPT · <workspace> 规划、实现并复核这个任务：……
```

协作过程为：

```text
INIT → PLAN → Codex 执行 → EXECUTED → ChatGPT 复核 → DONE / 下一轮
```

Codex 只发送很短的控制消息。ChatGPT 通过 App 自己读取文件和 diff，不需要把大文件粘贴进网页聊天。

## 重启与故障恢复

先运行：

```powershell
node .\bin\c2c.js doctor -w "C:\path\to\workspace" --json
```

常见处理：

- 固定域名正常：重启本地连接即可，ChatGPT App 地址保持不变。
- Cloudflare 授权过期：重新登录 Cloudflare，再运行 doctor；无需删除 App。
- 临时地址变化：只删除当前工作区对应的旧 App，再用相同名称和新地址创建。
- 配对过期：生成新的单次配对码。
- ChatGPT 显示 App unavailable：先确认管理页连接正常，再在 Project 中新建 Chat 对话并重新选择 App。
- 工作区读错：立即停止，检查 Project 指令和所选 App 名称。

## 安全边界

- Bridge 只监听本机回环地址。
- ChatGPT 暴露的是只读工具，不包含写文件、删除、Shell 或 Git push。
- 每个授权令牌绑定单一工作区。
- 路径逃逸、符号链接逃逸和敏感文件读取受到限制。
- 公网地址本身不能直接取得仓库内容，访问仍需授权。
- 长期凭据不进入聊天；浏览器中只输入短期、一次性的配对码。

完整设计见 [架构](docs/architecture.md)、[安全模型](docs/security.md)、[协议](docs/protocol.md) 和 [故障排查](docs/troubleshooting.md)。

## 开发与验证

```powershell
pnpm install
pnpm build
pnpm test
```

主要目录：

```text
src/          Bridge、只读工具、授权、GitHub、连接和进程管理
skill/        Codex 使用的完整自动化工作流
tests/        单元和集成测试
docs/         架构、安全、协议和运维文档
```

## 状态与声明

当前 v3 已实际验证：Windows 本机工作区读取、ChatGPT Project、App 配对、固定 Cloudflare 域名、GitHub 仓库识别、执行记录和 ChatGPT 独立复核。

这是非官方社区项目，与 OpenAI、Microsoft 或 Cloudflare 无关联，也未获其背书。

## License

[MIT](LICENSE)
