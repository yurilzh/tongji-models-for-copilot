# Tongji Models for Copilot Chat

把**同济大学人工智能服务平台**（<https://agi.tongji.edu.cn>）的模型接入 VS Code Copilot Chat，模型中会出现一个 **Tongji** 模型组。

平台提供 OpenAI 兼容接口，本扩展通过 `vscode.lm.registerLanguageModelChatProvider` 注册 `tongji` vendor，因此可以在 Copilot Chat 的模型选择器里直接选用同济的模型，包括 Agent 模式下的工具调用。

## 功能

- 自动从 `GET /v1/models` 拉取当前套餐可用的对话模型（不在套餐内的模型会自动隐藏）
- 流式输出、深度思考（`reasoning` / `reasoning_content`）内容展示、用量上报
- 工具调用（function calling），可用于 Copilot 的 Agent / 编辑模式
- 图像多模态输入
- 每个模型独立的**思考深度**选择器，对应平台统一的 `reasoning_effort` 参数
- 网络自适应：优先走服务端内网地址，失败时回退系统 DNS

## 环境要求

- VS Code 1.116 及以上，且已登录 GitHub Copilot（Copilot Chat）
- 校园网或已连接学校 VPN：平台的模型接口只对校园网 IP 开放

> 如果你的电脑装了代理，`agi.tongji.edu.cn` 常被解析到公网地址 `202.120.188.x`，此时接口会返回 `403 当前网络环境不支持`。本扩展默认把请求连到内网地址 `10.67.0.251`（TLS 仍按域名校验），一般无需修改 hosts；如需改走系统 DNS，把 `tongji.internalAddress` 置空即可。

## 使用

1. 在 <https://agi.tongji.edu.cn/system/my-apikey> 创建套餐 Key
2. 在命令面板运行 **Tongji: 设置 API Key**，粘贴 `sk-...`（保存在 VS Code 加密的 SecretStorage 中）
3. 打开 Copilot Chat 的模型选择器，选择 **Tongji** 分组下的模型

也可以不通过命令，把 Key 写到以下任一位置（优先级从高到低）：

1. SecretStorage（命令写入）
2. 设置项 `tongji.apiKey`
3. 文件 `~/.tongji-copilot/api-key`
4. 环境变量 `TONGJI_API_KEY`

## 设置

| 设置项                   | 默认值                         | 说明                                 |
| ------------------------ | ------------------------------ | ------------------------------------ |
| `tongji.baseUrl`         | `https://agi.tongji.edu.cn/v1` | OpenAI 兼容接口地址，写到 `/v1` 为止 |
| `tongji.internalAddress` | `10.67.0.251`                  | 服务端内网地址；留空表示使用系统 DNS |
| `tongji.maxOutputTokens` | `32768`                        | 单次请求最大输出 token 数            |

## 命令

| 命令                   | 说明                          |
| ---------------------- | ----------------------------- |
| `Tongji: 设置 API Key` | 保存 API Key 到 SecretStorage |
| `Tongji: 清除 API Key` | 删除已保存的 API Key          |
| `Tongji: 刷新模型列表` | 重新拉取 `GET /v1/models`     |
| `Tongji: 显示日志`     | 打开输出面板中的 Tongji 日志  |

## 思考深度

平台用请求体里的 `reasoning_effort` 统一控制思考开关与强度：`none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`。各模型支持的等级不同，扩展按模型详情页的 `thinking_levels` 只给出该模型支持的选项：

| 模型                            | 可选等级                          | 默认   |
| ------------------------------- | --------------------------------- | ------ |
| DeepSeek-V4.1-Flash             | none / low / high / xhigh / max   | high   |
| MiniMax-M3.1-Flash              | low / medium / high / xhigh / max | high   |
| GLM-5.3、GLM-5.3-Flash          | low / high / max                  | high   |
| MiMo-V2.6-Pro、MiMo-V2.6-Flash  | none / high                       | high   |
| Qwen3.8-Flash-Next、Qwen3.8-27B | none / low / medium / xhigh       | medium |
| Qwen3.8-Max                     | low / medium / xhigh              | medium |
| Kimi-K3                         | low / high / max                  | high   |

在模型选择器里点击模型名右侧的齿轮即可切换。

## 说明

- 本扩展由个人维护，与同济大学官方无隶属关系；接口可用性、额度与计费以平台为准。
- 思考 token 同样计入套餐额度，等级越高消耗越多。
- 扩展本身不包含任何 API Key，密钥只保存在本机。
- 拓展使用deepseek v4.1 flash + vscode copilot 许愿式编程完成

## 打包

```powershell
.\build.ps1            # 生成 tongji-copilot-<version>.vsix
.\build.ps1 -Install   # 生成并安装到本机
```

或使用官方工具：

```powershell
npx --yes @vscode/vsce@4.1.0 package
```

## 发布（GitHub Actions Trusted Publishing）

不需要保存 PAT，由 GitHub Actions 通过 OIDC 换取 Marketplace 会话令牌后发布。

1. 在 <https://marketplace.visualstudio.com/manage> 创建发布者，ID 与 `package.json` 的 `publisher` 一致
2. 把本仓库推到 GitHub，然后在发布者页面 **Trusted Publishing** 中新增策略：填写仓库 `<owner>/<repo>`、分支/标签规则以及工作流文件 `publish.yml`
   - 若该页面要求扩展已存在，先用 `npx @vscode/vsce publish -p <PAT>` 手工发布一次，再切换到 trusted publishing
3. 打标签或手动触发工作流即可发布：

```powershell
git tag v0.1.0
git push origin v0.1.0
```

工作流见 [.github/workflows/publish.yml](.github/workflows/publish.yml)，核心步骤为：

```yaml
permissions:
  contents: read
  id-token: write   # OIDC 必需
steps:
  - run: npx --yes @vscode/vsce@4.1.0 publish --oidc
```

也可以先在工作流页面手动运行一次并勾选 `dry_run`，只打包校验不发布。

> `vsce` 会提示缺少 `repository` 字段，创建 GitHub 仓库后补上即可：
> `npm pkg set repository.type=git repository.url=https://github.com/<owner>/vscode-tongji-api.git`
