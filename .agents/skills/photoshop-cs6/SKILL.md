---
name: photoshop-cs6
description: 通过 PowerShell + COM 自动化控制本机 Photoshop CS6（13.0）：新建/打开/保存/导出文档、图层与选区操作、文字、缩放与画布、调色滤镜、批量处理、任意 ExtendScript 执行（eval/run）。触发条件：用户要求用 Photoshop 处理图片、生成设计稿、加水印、批量转换格式或修改 PSD 时使用。
---

# Photoshop CS6 自动化

用本技能的 CLI 把 Photoshop CS6 当作无头渲染/编辑引擎来驱动。本机已装 64 位 CS6（`D:\Program Files\photoshop\Adobe Photoshop CS6 (64 Bit)`），COM 接口已注册，实测可用。

## 架构（必读一次）

- 唯一入口：`& '<技能目录>\ps6.ps1' <command> [args]`。PowerShell 5.1+ 原生 COM，零第三方依赖。
- 数据流：`ps6.ps1 → 临时 driver.jsx（UTF-8 无 BOM）→ COM DoJavaScriptFile → jsx/engine.jsx → result.json → ps6.ps1 打印`。临时文件自动清理。
- **每次命令输出一个单行 JSON**：成功 `{"ok":true,"data":{...}}`；失败 `{"ok":false,"error":"...","hint":"..."}` 且退出码 1。写脚本时逐条检查 `ok`。
- **状态在 PS 会话中保持**：每次 CLI 调用是独立进程，但文档、图层选择、选区留在 Photoshop 实例里。多步编辑 = 一连串命令；改图层前先 `layer select`；多文档用 `doc activate`。
- PS 未运行时命令会自动以 `/Automation` 模式拉起（冷启动约 5-10 秒）；操作超时默认 90 秒（`--timeout` 可调）。
- CS6 的 ExtendScript 没有内置 JSON——已由 `jsx/lib/helpers.jsx` 补齐；`jsx/engine.jsx` 是纯 ASCII（解析器兼容），错误消息为英文。

## 何时使用

- 用：批量改尺寸/转格式/加水印、从零生成设计稿（海报/封面/贴片）、单图编辑（调色/滤镜/文字/选区）、读写 PSD 图层结构。
- 不用：仅"看图"（先读图请用有视觉能力的模型或让用户看）；小图处理用 Python/PIL 或 ffmpeg 更快；需要 AI 生图素材时本技能不提供（用户提供素材或 PS 原生绘制）。

## 命令速查

| 命令 | 说明 | 示例 |
|---|---|---|
| `status` | PS 版本 + 所有打开文档列表（含 dirty 状态） | 任何操作前先跑 |
| `selftest` | 自检：新建→中文文字→导出 PNG→校验 | 排障第一步 |
| `doc new <w> <h> [--name] [--bg white\|transparent\|#RRGGBB]` | 新建 RGB 文档 | `doc new 800 600 --bg '#1a1a2e'` |
| `doc open <path>` / `doc activate (--name\|--index)` | 打开 / 切换活动文档 | `doc open D:\图\a.jpg` |
| `doc info` | 尺寸/模式/分辨率/图层列表/活动图层 | 编辑前必看 |
| `doc close [--save yes]` | 关闭文档（默认不保存） | |
| `save-as <path> [--format psd\|png\|jpg\|tiff\|bmp] [--quality 1-12]` | 保存副本，不影响原文档状态 | `save-as out.png --format png` |
| `export <path> [--format png\|jpg\|bmp\|tiff\|gif] [--quality] [--colors]` | 导出（gif 走存储为 Web 所用格式） | `export out.gif --format gif --colors 256` |
| `layer list` | 同 doc info（图层名/类型/可见/透明度/索引 0 起） | |
| `layer add [--kind empty\|text\|group] [--name] [--opacity]` | 加图层 | |
| `layer select (--name\|--index)` | 选择活动图层 | `layer select --index 2` |
| `layer remove (--name\|--index)` | 删图层 | 删除不可撤销，先确认 |
| `layer rename <newname>` / `layer visibility --on\|--off` / `layer translate <dx> <dy>` | 重命名/可见性/移动（像素，可负） | |
| `text add <文本> [--x --y --font --size --color #RRGGBB --bold]` | 加文字图层（x/y 为左上角像素） | `text add '标题' --x 60 --y 80 --size 56 --color '#ffffff' --bold` |
| `text set <文本> [--font --size --color --bold]` | 改活动文字图层 | 先 `layer select` |
| `resize <w> <h>` / `canvas <w> <h> [--anchor tl\|tc\|tr\|ml\|mc\|mr\|bl\|bc\|br]` | 改图像大小 / 画布大小（像素） | 等比需自己算 |
| `adjust bc <亮度> <对比度>` | 亮度/对比度（约 -100..100），作用于活动图层 | |
| `adjust hs <色相> <饱和度> [--lightness]` | 色相 -180..180，饱和度/明度 -100..100 | |
| `filter gaussian-blur <半径>` | 高斯模糊（像素） | |
| `filter unsharp-mask <数量> <半径> [--threshold]` | USM 锐化 | |
| `filter add-noise <数量> [--mono]` | 添加杂色 | |
| `selection all\|none\|invert` | 选区操作 | |
| `flatten` | 合并图层（隐藏图层会被丢弃，先确认） | |
| `batch <indir> <outdir> [--pattern] [--format] [--ops "<json>"]` | 批量：打开→按序操作→导出→关闭 | 见下方配方 |
| `eval "<一行 ExtendScript>"` | 万能门：执行任意 JS（PS 脚本模型） | 见下方片段库 |
| `run <script.jsx>` | 执行 .jsx 文件（须自包含，不支持 #include） | |
| `quit [--force]` | 退出 PS | 见安全准则，几乎不用 |

## 任务配方

### 批量缩放转格式

```powershell
& '<skill>\ps6.ps1' batch 'D:\照片\原图' 'D:\照片\web' --pattern '*.jpg' --format png `
  --ops '[{"op":"resize","args":{"width":800,"height":600}},{"op":"filter","args":{"name":"unsharp-mask","amount":80,"radius":1}}]'
```

### 加水印

```powershell
& '<skill>\ps6.ps1' doc open 'D:\图\封面.png'
& '<skill>\ps6.ps1' text add '内部资料 · 请勿外传' --x 420 --y 545 --size 26 --color '#ff6b6b'
& '<skill>\ps6.ps1' export 'D:\图\封面-水印.jpg' --format jpg --quality 9
& '<skill>\ps6.ps1' doc close
```

### 从零生成海报

```powershell
& '<skill>\ps6.ps1' doc new 800 600 --bg '#1a1a2e'
& '<skill>\ps6.ps1' text add '主标题' --x 60 --y 80 --size 56 --color '#ffffff' --bold
& '<skill>\ps6.ps1' text add '副标题' --x 62 --y 170 --size 30 --color '#f7b733'
& '<skill>\ps6.ps1' export 'D:\海报.png' --format png
& '<skill>\ps6.ps1' doc close
```

### 修改 PSD 里的文字

```powershell
& '<skill>\ps6.ps1' doc open 'D:\模板.psd'
& '<skill>\ps6.ps1' doc info                      # 找文字图层名
& '<skill>\ps6.ps1' layer select --name '标语'
& '<skill>\ps6.ps1' text set '新的标语内容' --color '#e74c3c'
& '<skill>\ps6.ps1' save-as 'D:\模板-改.psd' --format psd
& '<skill>\ps6.ps1' doc close
```

## eval 万能门片段库

v1 内置命令没覆盖的能力用 eval 补（表达式须是纯 JS 值，DOM 对象用包装器返回，如 `({name:app.activeDocument.name})`）：

```powershell
& '<skill>\ps6.ps1' eval "app.activeDocument.name"                                   # 活动文档名
& '<skill>\ps6.ps1' eval "({w:app.activeDocument.width.as('px'),h:app.activeDocument.height.as('px')})"
& '<skill>\ps6.ps1' eval "app.activeDocument.activeLayer.opacity = 70; 'ok'"         # 设不透明度（语句序列以最后表达式为值）
& '<skill>\ps6.ps1' eval "app.activeDocument.selection.selectAll(); app.activeDocument.selection.fill(app.foregroundColor); app.activeDocument.selection.deselect(); 'filled'"
```

## 安全准则（必须遵守）

1. **绝不 `quit` 用户正在用的 PS**：`quit` 只在自动化自己拉起的实例上考虑，且无未保存文档时仍需 `--force`。默认不退出，让它跑着。
2. **保护未保存工作**：`doc close` 默认不保存；改用户文件前先 `doc info` 看 `saved` 字段；任何破坏性操作（删图层、flatten、close）先向用户确认或在导出副本上做。
3. **导出到新文件/新目录**：永远 `save-as`/`export` 新路径，批量输出到独立 outdir，不覆盖原图。
4. **eval/run 只做 PS 内部操作**：不写系统命令、不删用户文件、不碰注册表；文件写入只经由 doc/save/export 命令。
5. 失败先看 `error`/`hint`，再跑 `selftest` 定位通道问题，不要盲目重试超时的命令。

## 故障排查

| 症状 | 处理 |
|---|---|
| `未产生结果文件` / 超时 | PS 可能弹了模态对话框；`Get-Process Photoshop` 看进程；必要时用户手动关掉对话框 |
| 字体报错 | 字体名要用 PS 认识的名称（PostScript 名）；中文默认可用 `SimSun`/`Microsoft YaHei`；`MyriadPro-Regular` 等西文字体不含中文字形，中文文字要用中文字体 |
| 中文乱码 | 检查 ps6.ps1 是否带 BOM（勿用无 BOM 编辑器重存）；driver 由脚本生成，勿手改 |
| 找不到 Photoshop | 检查 `D:\Program Files\photoshop\Adobe Photoshop CS6 (64 Bit)\Photoshop.exe` 与注册表 `HKCR\Photoshop.Application` |
| 图层索引找不到 | `layer list` 用 0 起始索引，逐条核对 |
| 导出格式不支持 | v1 支持 psd/png/jpg/bmp/tiff/gif；其他格式用 eval 写 ExtendScript |

## 已知限制（v1）

- 滤镜/调整是常用子集；更多效果用 `eval` 直接调 ExtendScript API。
- `resize` 不自动保持比例；等比缩放请自己按原尺寸计算。
- `run` 的脚本须自包含（不支持 `#include`）；需要 include 时把代码并入 eval。
- 批量是逐文件串行；大量文件时耐心等待，或分目录并行跑两个 batch。
- 无 AI 图像生成；素材由用户提供或 PS 原生绘制。
