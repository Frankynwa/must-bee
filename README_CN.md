# must-bee 🐝

**把澳科大 wemust / Moodle 和课表，变成 Agent 能直接驱动的 JSON。**

> *"老师又传新 PPT 了？"*
> *"明天交的是哪门作业来着？"*
> *"今晚到底有没有课？"*
>
> 登 wemust 不如直接问 AI。

**语言：** [English](./README.md) · [中文](./README_CN.md)

[![CI](https://github.com/Frankynwa/must-bee/actions/workflows/ci.yml/badge.svg)](https://github.com/Frankynwa/must-bee/actions/workflows/ci.yml)

---

> [!WARNING]
> **非官方项目。** must-bee 与澳门科技大学无隶属或背书关系。它自动化的是学生自己的
> Moodle 与课表会话；自动访问可能违反学校的可接受使用政策，请先确认，风险自负。

## 它能做什么

must-bee 用 Playwright 登录 M.U.S.T. CAS，然后把 Moodle 和课表包装成一个小 CLI：
**每条命令只向 stdout 输出一个 JSON 值**。任何会调用工具的 agent（Claude Code、
Hermes、Codex、自己写的脚本）都能直接驱动它，不用解析 HTML。

- 🔄 **增量同步** —— 只下载新增或变更的课件
- 📅 **课表** —— 今天 / 指定日期 / 整周
- 📚 **课程与材料** —— 全部课程、作业、quiz、课件
- 📝 **DDL** —— Moodle 日历上即将到期的事项
- 📄 **作业详情** —— 描述、提交状态、附件列表
- 📢 **公告正文** —— 论坛帖子全文，考试通知通常只在这里
- 🔗 **外链课件** —— 公告里的 Dropbox / Google Drive / OneDrive / MEGA / WeTransfer
- 🧠 **Obsidian 复习笔记** —— 可选：用 DeepSeek 把 PDF/PPTX 转成复习笔记
- 🧱 **JSON 优先** —— 给 agent 的稳定输出结构

## 快速开始

```bash
git clone https://github.com/Frankynwa/must-bee.git
cd must-bee
npm install
npx playwright install chromium

cp .env.example .env
# 编辑 .env：填写 MUSTER_USERNAME / MUSTER_PASSWORD

set -a && . ./.env && set +a
node scripts/muster_cli.js sync --all   # 首次全量同步
node scripts/muster_cli.js schedule     # 今天的课
```

或者让 Agent 帮你装，把下面这段贴给它：

````text
请帮我安装 must-bee 这个技能：https://github.com/Frankynwa/must-bee

按以下流程做：
1. 把仓库 clone 到你的 skills 目录
2. cd 进去，跑 `npm install && npx playwright install chromium`
3. 问我要 MUSTer 账号密码（不要自己编），写进 .env 的
   MUSTER_USERNAME / MUSTER_PASSWORD
4. 跑 `node scripts/muster_cli.js status` 验证能用
5. 告诉我可以怎么开始用
````

## 命令一览

所有命令都是 `node scripts/muster_cli.js <command>`。任意命令加 `--debug`，
会把 `[debug]` 追踪信息打到 stderr。

| 命令 | 作用 | 联网 |
|---|---|---|
| `sync [--week [DATE]] [--all]` | 增量同步（默认本周；`--all` 整学期） | 是 |
| `schedule [--date DATE] [--week [DATE]]` | 某天 / 整周课表 | 缓存，缺了才联网 |
| `courses [--live]` | 已注册课程（缓存为空时自动同步一次） | 缓存；`--live` 直接联网 |
| `course --code CODE` | 单课：作业 / quiz / 材料 / 公告 | 是 |
| `assign --url URL` / `--code CODE [--name TEXT]` | 单个作业：描述、状态、附件 | 是 |
| `post --url URL` / `--code CODE [--name TEXT]` | 单条公告正文 | 是 |
| `forum --url URL` / `--code CODE [--bodies]` | 所有论坛的所有帖子（可带正文） | 是 |
| `links --code CODE` | 课程页每一条活动 / 资源链接 | 是 |
| `get --url URL [--out DIR]` | 用已登录会话下载单个 Moodle 文件 | 是 |
| `pending [--course CODE]` | 即将到期的 Moodle 事项 | 是 |
| `files [--course CODE] [--date DATE] [--recent [--n N]]` | 检索已下载文件 | 缓存 |
| `notes [--course CODE] [--dry-run] [--force] [--limit N]` | 生成 Obsidian 复习笔记 | 是（调 LLM） |
| `status` | 同步状态概览 | 缓存 |
| `--version`、`--help` | 版本 / 用法 | — |

`files --course CODE --date DATE` 返回**上一节课到目标日期之间**新增的文件——
专门用来预习指定那节课。

## 配置

| 环境变量 | 必需 | 默认值 | 说明 |
|---|---|---|---|
| `MUSTER_USERNAME` | 是* | — | 澳科大账号 |
| `MUSTER_PASSWORD` | 是* | — | 澳科大密码 |
| `MUSTER_DOWNLOAD_PATH` | 否 | `~/.must-bee` | 下载/状态根目录（文件落在 `<root>/wemust/`） |
| `MUSTER_NO_SANDBOX` | 否 | `0` | 仅当 Chromium 无法启用沙箱时设为 `1`（如容器内 root） |
| `MUSTER_MAX_DOWNLOAD_MB` | 否 | `200` | 公告外链单文件大小上限 |
| `MUSTER_PYTHON` | 否 | `python3` | `notes` 使用的 Python |
| `DEEPSEEK_API_KEY` | `notes` 需要 | — | 生成笔记的 API key |
| `DEEPSEEK_API_BASE` | 否 | `https://api.deepseek.com` | 任何 DeepSeek 兼容端点 |
| `DEEPSEEK_MODEL` | 否 | `deepseek-chat` | 生成笔记的模型 |
| `OBSIDIAN_VAULT_PATH` | `notes` 需要 | `~/Vaults/Obsidian`、`~/Obsidian` 中先存在的 | 库根目录；笔记写到 `Courses/<课程> <代码>/` |
| `MUST_BEE_ENV` | 否 | — | `notes` 额外加载的 `.env` 文件 |

\* 纯缓存命令（`status`、不带 `--date` 的 `files`）不需要凭据；其他要访问
Moodle 的命令都需要。

`notes` 还需要 Python 依赖：

```bash
python3 -m pip install -r requirements-notes.txt
```

## 安全与隐私

- **凭据只在本地。** 账号密码从环境变量（或 `.env`）读入，只填到 M.U.S.T.
  登录页。must-bee 没有遥测、没有远程日志，也不会把凭据写到磁盘；`.env`
  已被 gitignore。
- **默认开启 Chromium 沙箱。** `MUSTER_NO_SANDBOX=1` 只是给沙箱无法工作的
  环境（如容器内 root）留的显式开关。
- **下载有上限。** 公告外链单文件 200 MB；zip 解压限制 500 个条目、单文件
  100 MB、总量 300 MB（防解压炸弹 / 内存 DoS）。
- **`get` 不是开放代理。** 只接受 `*.must.edu.mo` 的 URL。
- **LLM 隐私。** `notes` 会把课件提取出的文本发给配置的 DeepSeek 兼容接口。
  如果课件涉密，不要跑 `notes`，或把 `DEEPSEEK_API_BASE` 指向本地端点。
- 威胁模型与漏洞报告方式见 [SECURITY.md](./SECURITY.md)。

## 依赖

- Node.js ≥ 18
- Chromium（`npx playwright install chromium`）
- Python 3.9+（仅 `notes` 需要）

## 实现说明

- Playwright 驱动无头 Chromium 走 M.U.S.T. CAS 登录。
- Moodle 页面通过已登录的浏览器上下文读取；CLI 没有重新实现 Moodle 的
  web service API。
- 课表 SPA 自己给请求签名，所以 must-bee 挂 `XMLHttpRequest` 钩子，直接读
  页面已经收到的响应，而不是逆向签名。
- 所有结果都是 JSON：stdout 一个值；错误是 stderr 上的
  `{"error": "...", "partialReport"?: {...}}`，退出码非 0。

每条命令的具体输出结构见 [SKILL.md](./SKILL.md#output-shapes)。

## 致谢

must-bee fork 自 [Cosmostima/muster_skill](https://github.com/Cosmostima/muster_skill)
（MIT）。原始版权 © 2026 Cosmostima。本 fork 增加了课表抓取、公告/论坛扫描、
外链课件下载、作业/公告详情、Obsidian 笔记生成，以及大量安全加固。

## 许可证

[MIT](./LICENSE)
