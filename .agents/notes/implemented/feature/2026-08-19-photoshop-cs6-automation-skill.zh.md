# Agent Note: Photoshop CS6 automation skill

Status: implemented

[English](2026-08-19-photoshop-cs6-automation-skill.md) | 中文

## Problem

用户希望 agent 操作其桌面上的 Photoshop CS6（13.0，64 位，装在 `D:\Program Files\photoshop\Adobe Photoshop CS6 (64 Bit)`），完成单图编辑、设计生成、批量处理和 PSD 工程操作。CS6 早于 UXP、没有 HTTP 接口，agent 此前没有任何途径驱动它。UI 自动化过于脆弱；且当前部署的模型不能读图（见 [minimal read-image tool](2026-08-10-minimal-read-image-tool.zh.md)），因此通道必须返回结构化数据，视觉产物必须能在无视觉能力的情况下验证。

## Decision

在仓库级技能目录 [`.agents/skills/photoshop-cs6/`](../../../skills/photoshop-cs6/SKILL.md) 落地一个技能，通过已注册的 COM 服务器（`Photoshop.Application` → `Photoshop.exe /Automation`）驱动 ExtendScript 引擎：

- **`ps6.ps1`** — PowerShell 5.1+ CLI，唯一入口。子命令 `status` `selftest` `doc` `save-as` `export` `layer` `text` `resize` `canvas` `adjust` `filter` `selection` `flatten` `batch` `eval` `run` `quit`；每次调用只输出一个 JSON 对象，失败输出 `{ok:false,error,hint}` 且退出码 1；每次 COM 调用在 `Start-Job`/`Wait-Job` 超时保护下执行（默认 90 秒，`--timeout` 可调）。
- **`jsx/lib/helpers.jsx`** — CS6 的 ExtendScript（ES3）没有内置 JSON，此文件提供带深度上限的 `JSON.stringify`、UTF-8 结果写入与路径工具。
- **`jsx/engine.jsx`** — 纯 ASCII 操作引擎。每次调用，`ps6.ps1` 写入一个临时 UTF-8 无 BOM driver（`#include` helpers 与 engine、以 JS 对象字面量内嵌请求、调用 `ps6Execute(req, resultPath)`）；引擎把结果写入临时 `result.json`，CLI 读取后清理。每次执行把标尺/文字单位设为像素、`displayDialogs = NO`，结束后恢复原偏好；所有操作错误都被捕获进载荷。
- **`SKILL.md`**（中文）— 命令表、任务配方（批量、水印、海报、PSD 文字修改）、ExtendScript 片段库与安全准则。

`eval`（一行 ExtendScript）与 `run`（自包含 .jsx）是刻意的逃生门：v1 操作集未覆盖的能力都能触达，无需新增命令。

skill-filesystem provider 自动发现 `.agents/skills/*`（来源 `project-agents`，rank 200）并在宿主文件变更时热刷新目录（[skill catalog hot refresh](2026-07-27-skill-catalog-hot-refresh.zh.md)），因此技能无需改组合、无需重建、无需重启即在运行中的会话可见——源码持久化、效果即时。

### 无视觉验证

`selftest` 跑通全通道（新建文档 → 中文文字图层 → 导出 PNG）并校验字节级产物。视觉产物用 `System.Drawing` 像素采样程序化验证：画布尺寸、背景色、各颜色文字像素计数。本机三项全绿：800×600 海报三层文字（白/橙/灰蓝像素均存在）、带水印的 JPG 导出、3 文件批量缩放到 400×300。

### 安全规则

存在未保存文档时 `quit` 拒绝退出，其余情况退出仍需 `--force`；`doc close` 默认不保存；`batch` 输出到独立目录；SKILL.md 将 `eval`/`run` 限制为 Photoshop 内部操作。技能绝不自动退出用户正在使用的实例。

## Alternatives considered

**Python Click + pywin32/comtypes（cli-anything 标准路线）。** 否决：`pywin32` 未安装且安装需要网络；PowerShell COM 已在会话中实测可用；无论驱动语言是什么，ExtendScript DOM 都能经 `eval` 触达。

**纯 ExtendScript 走 ExtendScript Toolkit `-run` 命令行。** 否决：ESTK CS6 命令行自动化以不稳定著称，且没有回传结构化输出的通道。

**Windows UI Automation。** 否决：对布局复杂的桌面应用做坐标/控件树点击，脆弱且难维护。

**在 harness 的 `packages/` 里做原生工具包。** 否决：把 harness 构建绑死到某台机器的某个桌面应用。`.agents/skills/` 下的技能资产才是正确平面——零构建耦合、热加载，且按用户"持久化升级源码"的要求随仓库持久化。

## Testing

`ps6.ps1 selftest` 是通道级自检（COM 连接、UTF-8 往返、文字、PNG 导出）。三项端到端演示（海报、水印、批量）以像素采样验证。`pnpm run verify-skill-invocation-metadata` 与 Agent Note 各校验门（`verify-agent-note-format`、`verify-agent-note-classification`、`verify-translation-pairing`）均通过。

## Consequences

- 单机范围：Windows + CS6 位于已知路径且 `Photoshop.Application` 已注册。换机器需重跑 `selftest` 并更新 SKILL.md。
- 每次命令承担一次 job 进程启动（约 1–2 秒）加 COM 连接；`batch` 逐文件串行。
- 文档、活动图层、选区状态在 Photoshop 实例内跨 CLI 调用保持——多步编辑是一串命令，不是单次调用。
- ExtendScript JSON 序列化器有深度上限并跳过函数；DOM 对象序列化为 `{}`，所以 `eval` 结果必须是纯 JS 值（SKILL.md 给出了包装写法）。
- `run` 不支持 `#include`；`resize` 不保持宽高比；滤镜与调整是精选子集——均可经 `eval` 绕过。
- `ps6.ps1` 必须保留 UTF-8 BOM（Windows PowerShell 5.1 会把无 BOM UTF-8 当 ANSI 解析）；`engine.jsx` 必须保持纯 ASCII；driver 为无 BOM UTF-8。
- 无 AI 图像生成：设计生成素材来自用户或 Photoshop 原生绘制。
