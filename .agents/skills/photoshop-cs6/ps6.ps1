<# ps6.ps1 — Photoshop CS6 automation CLI for the photoshop-cs6 skill.
The single entry point agents use to drive the local Photoshop CS6 through
its COM interface + ExtendScript engine (jsx/engine.jsx). Every command
prints one JSON object; failures print {ok:false,error,hint} and exit 1.

usage: ps6.ps1 <command> [args] [--json] [--timeout <sec>]
commands: status selftest doc save-as export layer text resize canvas
          adjust filter selection flatten batch eval run quit
#>

$ErrorActionPreference = 'Stop'
$Script:SkillDir = $PSScriptRoot
$Script:TimeoutSec = 90

function Usage {
  Write-Output 'photoshop-cs6 / ps6.ps1 commands:'
  Write-Output '  status | selftest | quit [--force]'
  Write-Output '  doc new <w> <h> [--name s] [--bg white|transparent|#RRGGBB]'
  Write-Output '  doc open <path> | doc info | doc close [--save yes|no] | doc activate (--name s|--index n)'
  Write-Output '  save-as <path> [--format psd|png|jpg|tiff|bmp] [--quality 1-12] [--compression 0-9]'
  Write-Output '  export <path> [--format png|jpg|bmp|tiff|gif] [--quality] [--colors]'
  Write-Output '  layer list | layer add [--kind empty|text|group] [--name s] [--opacity 0-100]'
  Write-Output '  layer select (--name s|--index n) | layer remove (--name s|--index n)'
  Write-Output '  layer rename <newname> | layer visibility --on|--off | layer translate <dx> <dy>'
  Write-Output '  text add <text> [--x n --y n --font s --size n --color #RRGGBB --bold]'
  Write-Output '  text set <text> [--font s --size n --color #RRGGBB --bold]'
  Write-Output '  resize <w> <h> | canvas <w> <h> [--anchor tl|tc|tr|ml|mc|mr|bl|bc|br]'
  Write-Output '  adjust bc <brightness> <contrast> | adjust hs <hue> <saturation> [--lightness n]'
  Write-Output '  filter gaussian-blur <radius> | filter unsharp-mask <amount> <radius> [--threshold n] | filter add-noise <amount> [--mono]'
  Write-Output '  selection all|none|invert | flatten'
  Write-Output '  batch <indir> <outdir> [--pattern *.jpg] [--format png] [--ops "<json>"]'
  Write-Output '  eval "<one line of ExtendScript>" | run <script.jsx>'
  Write-Output 'global: --json (always on), --timeout <sec> (default 90)'
}

function Parse-Args([string[]]$raw) {
  $named = @{}
  $pos = @()
  for ($i = 0; $i -lt $raw.Count; $i++) {
    $a = $raw[$i]
    if ($a -like '--*') {
      $key = $a.Substring(2)
      if (($i + 1) -lt $raw.Count -and $raw[$i + 1] -notlike '--*') {
        $named[$key] = $raw[$i + 1]
        $i++
      } else {
        $named[$key] = $true
      }
    } else {
      $pos += $a
    }
  }
  return @{ Named = $named; Pos = $pos }
}

function To-JsLiteral($v) {
  if ($null -eq $v) { return 'null' }
  if ($v -is [string]) { return (ConvertTo-Json -InputObject $v -Compress) }
  if ($v -is [bool]) { return $(if ($v) { 'true' } else { 'false' }) }
  if ($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal]) {
    return $v.ToString([System.Globalization.CultureInfo]::InvariantCulture)
  }
  if ($v -is [System.Collections.IDictionary]) {
    $items = @()
    foreach ($k in @($v.Keys)) {
      $keyLit = ConvertTo-Json -InputObject ([string]$k) -Compress
      $items += ($keyLit + ':' + (To-JsLiteral $v[$k]))
    }
    return '{' + ($items -join ',') + '}'
  }
  if ($v -is [System.Collections.IEnumerable]) {
    $items = @()
    foreach ($x in @($v)) { $items += (To-JsLiteral $x) }
    return '[' + ($items -join ',') + ']'
  }
  return (ConvertTo-Json -InputObject ([string]$v) -Compress)
}

function Invoke-Ps6([hashtable]$Req) {
  $tmp = Join-Path $env:TEMP ('ps6-' + $PID + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $null = New-Item -ItemType Directory -Path $tmp -Force
  $job = $null
  try {
    $driver = Join-Path $tmp 'driver.jsx'
    $resultPath = Join-Path $tmp 'result.json'
    $helpers = (Join-Path $Script:SkillDir 'jsx/lib/helpers.jsx') -replace '\\', '/'
    $engine = (Join-Path $Script:SkillDir 'jsx/engine.jsx') -replace '\\', '/'
    $reqLit = To-JsLiteral $Req
    $resultFwd = $resultPath -replace '\\', '/'
    $src = "#include `"$helpers`"`n#include `"$engine`"`nvar __REQ = $reqLit;`nps6Execute(__REQ, `"$resultFwd`");"
    [System.IO.File]::WriteAllText($driver, $src, (New-Object System.Text.UTF8Encoding($false)))
    $job = Start-Job -ArgumentList $driver -ScriptBlock {
      param($d)
      $app = New-Object -ComObject Photoshop.Application
      $null = $app.DoJavaScriptFile($d)
    }
    if (-not (Wait-Job $job -Timeout $Script:TimeoutSec)) {
      Stop-Job $job -ErrorAction SilentlyContinue
      throw "Photoshop 操作超时（$($Script:TimeoutSec)s）——PS 可能弹出了模态对话框或正在忙"
    }
    $null = Receive-Job $job -Keep
    if (Test-Path $resultPath) {
      $raw = [System.IO.File]::ReadAllText($resultPath)
      try { return (ConvertFrom-Json $raw) }
      catch { throw "无法解析 Photoshop 返回结果: $raw" }
    }
    throw 'Photoshop 未产生结果文件——脚本未成功执行'
  } finally {
    if ($job) { Remove-Job $job -Force -ErrorAction SilentlyContinue }
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Finish($res) {
  $json = $res | ConvertTo-Json -Depth 12 -Compress
  Write-Output $json
  if ($res -is [pscustomobject] -and $null -ne $res.PSObject.Properties['ok'] -and $res.ok -eq $false) {
    exit 1
  }
  if ($res -is [System.Collections.IDictionary] -and $res['ok'] -eq $false) {
    exit 1
  }
}

function Fail([string]$msg, [string]$hint) {
  Finish(@{ ok = $false; error = $msg; hint = $hint })
}

function Get-Double([string]$s, [double]$default) {
  if ($null -eq $s -or $s -eq '') { return $default }
  $n = 0.0
  if ([double]::TryParse($s, [ref]$n)) { return $n }
  return $default
}

function Get-Bool([string]$s, [bool]$default) {
  if ($null -eq $s -or $s -eq '') { return $default }
  if ($s -eq '1' -or $s -eq 'true' -or $s -eq 'on' -or $s -eq 'yes') { return $true }
  if ($s -eq '0' -or $s -eq 'false' -or $s -eq 'off' -or $s -eq 'no') { return $false }
  return $default
}

function Invoke-WithCheck([hashtable]$Req, [string]$hint) {
  $res = Invoke-Ps6 $Req
  if ($res.ok -eq $false) {
    $h = $res.hint
    if (-not $h) { $h = $hint }
    Finish(@{ ok = $false; error = $res.error; hint = $h })
    return $null
  }
  return $res
}

# ---- entry ---------------------------------------------------------------

$argv = @($args)
if ($argv.Count -eq 0) {
  Fail 'missing command' 'status|selftest|doc|save-as|export|layer|text|resize|canvas|adjust|filter|selection|flatten|batch|eval|run|quit（详见 ps6.ps1 --help）'
  exit 2
}
if ($argv[0] -eq '--help' -or $argv[0] -eq 'help' -or $argv[0] -eq '-h') {
  Usage
  exit 0
}
$cmd = $argv[0].ToLowerInvariant()
$p = Parse-Args @($argv | Select-Object -Skip 1)
$named = $p.Named
$pos = $p.Pos
if ($null -ne $named['timeout']) {
  $Script:TimeoutSec = [int](Get-Double ([string]$named['timeout']) 90)
}

try {
  switch ($cmd) {
    'status' {
      Finish (Invoke-WithCheck @{ op = 'status'; args = @{} } '检查 Photoshop 是否运行、COM 是否注册')
    }
    'selftest' {
      $png = Join-Path $env:TEMP ('ps6-selftest-' + $PID + '.png')
      $res = Invoke-WithCheck @{ op = 'selftest'; args = @{ pngPath = $png; text = 'PS6 selftest 中文测试 123' } } 'selftest 失败'
      if ($null -ne $res) {
        $exists = Test-Path $png
        $bytes = 0
        if ($exists) { $bytes = (Get-Item $png).Length }
        Remove-Item $png -Force -ErrorAction SilentlyContinue
        Finish @{ ok = $true; data = @{ ps = $res.data; pngWritten = $exists; pngBytes = $bytes } }
      }
    }
    'quit' {
      $running = Get-Process Photoshop -ErrorAction SilentlyContinue
      if (-not $running) {
        Finish @{ ok = $true; data = @{ quit = $false; reason = 'Photoshop 未在运行' } }
      } else {
        $st = Invoke-Ps6 @{ op = 'status'; args = @{} }
        $dirty = @()
        if ($st.ok) {
          foreach ($d in @($st.data.documents)) { if (-not $d.saved) { $dirty += $d.name } }
        }
        if ($dirty.Count -gt 0) {
          Fail '存在未保存的文档，拒绝退出' ("未保存文档: " + ($dirty -join ', ') + '；请先由用户保存，或在 agent 确认放弃后逐个 close')
        } elseif (-not $named['force']) {
          Fail '需要 --force 确认退出 Photoshop' '若确实要关闭（无未保存文档），加 --force'
        } else {
          $app = New-Object -ComObject Photoshop.Application
          $app.Quit() | Out-Null
          Finish @{ ok = $true; data = @{ quit = $true } }
        }
      }
    }
    'doc' {
      $sub = if ($pos.Count -gt 0) { $pos[0].ToLowerInvariant() } else { '' }
      $rest = @($pos | Select-Object -Skip 1)
      switch ($sub) {
        'new' {
          if ($rest.Count -lt 2) { Fail '用法: doc new <w> <h> [--name s] [--bg ...]' '宽高为像素数' }
          else {
            $w = Get-Double ([string]$rest[0]) 0; $h = Get-Double ([string]$rest[1]) 0
            if ($w -le 0 -or $h -le 0) { Fail '宽高必须是正数' '例如: doc new 800 600' }
            else {
              $argsH = @{ width = $w; height = $h }
              if ($named['name']) { $argsH.name = [string]$named['name'] }
              if ($named['bg']) { $argsH.bg = [string]$named['bg'] }
              Finish (Invoke-WithCheck @{ op = 'doc-new'; args = $argsH } '新建文档失败')
            }
          }
        }
        'open' {
          if ($rest.Count -lt 1) { Fail '用法: doc open <path>' '绝对或相对路径均可' }
          else { Finish (Invoke-WithCheck @{ op = 'doc-open'; args = @{ path = [string]$rest[0] } } '打开失败——路径存在吗？格式受支持吗？') }
        }
        'info' { Finish (Invoke-WithCheck @{ op = 'doc-info'; args = @{} } '无活动文档') }
        'close' {
          $save = if ($named['save'] -and (Get-Bool ([string]$named['save']) $false)) { 'yes' } else { 'no' }
          Finish (Invoke-WithCheck @{ op = 'doc-close'; args = @{ save = $save } } '关闭文档失败')
        }
        'activate' {
          if ($named['index']) { Finish (Invoke-WithCheck @{ op = 'doc-activate'; args = @{ index = (Get-Double ([string]$named['index']) -1) } } '文档序号超出范围') }
          elseif ($named['name']) { Finish (Invoke-WithCheck @{ op = 'doc-activate'; args = @{ name = [string]$named['name'] } } '找不到该文档名') }
          else { Fail '用法: doc activate (--name s|--index n)' '索引从 0 开始' }
        }
        default { Fail '未知 doc 子命令' 'doc new|open|info|close|activate' }
      }
    }
    'save-as' {
      if ($pos.Count -lt 1) { Fail '用法: save-as <path> [--format psd|png|jpg|tiff|bmp] [--quality 1-12]' '保存为副本，不影响当前文档状态' }
      else {
        $argsH = @{ path = [string]$pos[0] }
        if ($named['format']) { $argsH.format = [string]$named['format'] }
        if ($named['quality']) { $argsH.quality = Get-Double ([string]$named['quality']) 10 }
        if ($named['compression']) { $argsH.compression = Get-Double ([string]$named['compression']) 0 }
        Finish (Invoke-WithCheck @{ op = 'save-as'; args = $argsH } '保存失败——格式或路径有问题？')
      }
    }
    'export' {
      if ($pos.Count -lt 1) { Fail '用法: export <path> [--format png|jpg|bmp|tiff|gif] [--quality] [--colors]' 'png/jpg/bmp/tiff 走 saveAs，gif 走存储为 Web 所用格式' }
      else {
        $argsH = @{ path = [string]$pos[0] }
        if ($named['format']) { $argsH.format = [string]$named['format'] }
        if ($named['quality']) { $argsH.quality = Get-Double ([string]$named['quality']) 10 }
        if ($named['colors']) { $argsH.colors = Get-Double ([string]$named['colors']) 256 }
        if ($named['compression']) { $argsH.compression = Get-Double ([string]$named['compression']) 0 }
        Finish (Invoke-WithCheck @{ op = 'export'; args = $argsH } '导出失败')
      }
    }
    'layer' {
      $sub = if ($pos.Count -gt 0) { $pos[0].ToLowerInvariant() } else { '' }
      $rest = @($pos | Select-Object -Skip 1)
      switch ($sub) {
        'list' { Finish (Invoke-WithCheck @{ op = 'doc-info'; args = @{} } '无活动文档') }
        'add' {
          $argsH = @{}
          if ($named['kind']) { $argsH.kind = [string]$named['kind'] }
          if ($named['name']) { $argsH.name = [string]$named['name'] }
          if ($named['opacity']) { $argsH.opacity = Get-Double ([string]$named['opacity']) 100 }
          Finish (Invoke-WithCheck @{ op = 'layer-add'; args = $argsH } '添加图层失败')
        }
        'select' {
          if ($named['index']) { Finish (Invoke-WithCheck @{ op = 'layer-select'; args = @{ index = (Get-Double ([string]$named['index']) -1) } } '图层序号超出范围') }
          elseif ($named['name']) { Finish (Invoke-WithCheck @{ op = 'layer-select'; args = @{ name = [string]$named['name'] } } '找不到该图层名（用 layer list 查看）') }
          else { Fail '用法: layer select (--name s|--index n)' '索引从 0 开始' }
        }
        'remove' {
          if ($named['index']) { Finish (Invoke-WithCheck @{ op = 'layer-remove'; args = @{ index = (Get-Double ([string]$named['index']) -1) } } '图层序号超出范围') }
          elseif ($named['name']) { Finish (Invoke-WithCheck @{ op = 'layer-remove'; args = @{ name = [string]$named['name'] } } '找不到该图层名') }
          else { Fail '用法: layer remove (--name s|--index n)' '索引从 0 开始' }
        }
        'rename' {
          if ($rest.Count -lt 1) { Fail '用法: layer rename <newname>' '重命名当前活动图层' }
          else { Finish (Invoke-WithCheck @{ op = 'layer-rename'; args = @{ newname = [string]$rest[0] } } '重命名失败') }
        }
        'visibility' {
          $v = $true
          if ($named['off']) { $v = $false }
          elseif ($named['on']) { $v = $true }
          else { Fail '用法: layer visibility --on|--off' '控制当前活动图层可见性' }
          Finish (Invoke-WithCheck @{ op = 'layer-visibility'; args = @{ visible = $v } } '设置可见性失败')
        }
        'translate' {
          if ($rest.Count -lt 2) { Fail '用法: layer translate <dx> <dy>' '像素，可为负' }
          else { Finish (Invoke-WithCheck @{ op = 'layer-translate'; args = @{ dx = (Get-Double ([string]$rest[0]) 0); dy = (Get-Double ([string]$rest[1]) 0) } } '移动图层失败') }
        }
        default { Fail '未知 layer 子命令' 'layer list|add|select|remove|rename|visibility|translate' }
      }
    }
    'text' {
      $sub = if ($pos.Count -gt 0) { $pos[0].ToLowerInvariant() } else { '' }
      $rest = @($pos | Select-Object -Skip 1)
      $argsH = @{}
      if ($named['font']) { $argsH.font = [string]$named['font'] }
      if ($named['size']) { $argsH.size = Get-Double ([string]$named['size']) 0 }
      if ($named['color']) { $argsH.color = [string]$named['color'] }
      if ($named['bold']) { $argsH.bold = $true }
      switch ($sub) {
        'add' {
          if ($rest.Count -lt 1) { Fail '用法: text add <text> [--x n --y n --font s --size n --color #RRGGBB --bold]' 'x/y 为文字左上角像素位置' }
          else {
            $argsH.text = [string]$rest[0]
            if ($null -ne $named['x'] -and $null -ne $named['y']) {
              $argsH.x = Get-Double ([string]$named['x']) 0
              $argsH.y = Get-Double ([string]$named['y']) 0
            }
            Finish (Invoke-WithCheck @{ op = 'text-add'; args = $argsH } '加文字失败——字体名是否本机存在？')
          }
        }
        'set' {
          if ($rest.Count -lt 1) { Fail '用法: text set <text> [--font s --size n --color #RRGGBB --bold]' '修改当前活动文字图层' }
          else {
            $argsH.text = [string]$rest[0]
            Finish (Invoke-WithCheck @{ op = 'text-set'; args = $argsH } '修改文字失败——活动图层是文字图层吗？')
          }
        }
        default { Fail '未知 text 子命令' 'text add|set' }
      }
    }
    'resize' {
      if ($pos.Count -lt 2) { Fail '用法: resize <w> <h>' '像素，等比缩放请自行计算' }
      else { Finish (Invoke-WithCheck @{ op = 'resize'; args = @{ width = (Get-Double ([string]$pos[0]) 0); height = (Get-Double ([string]$pos[1]) 0) } } '缩放失败') }
    }
    'canvas' {
      if ($pos.Count -lt 2) { Fail '用法: canvas <w> <h> [--anchor mc]' 'anchor: tl/tc/tr/ml/mc/mr/bl/bc/br，默认 mc' }
      else {
        $argsH = @{ width = (Get-Double ([string]$pos[0]) 0); height = (Get-Double ([string]$pos[1]) 0) }
        if ($named['anchor']) { $argsH.anchor = [string]$named['anchor'] }
        Finish (Invoke-WithCheck @{ op = 'canvas'; args = $argsH } '改画布失败')
      }
    }
    'adjust' {
      $sub = if ($pos.Count -gt 0) { $pos[0].ToLowerInvariant() } else { '' }
      $rest = @($pos | Select-Object -Skip 1)
      if ($sub -eq 'bc') {
        if ($rest.Count -lt 2) { Fail '用法: adjust bc <brightness> <contrast>' '典型 -100..100' }
        else { Finish (Invoke-WithCheck @{ op = 'adjust-bc'; args = @{ brightness = (Get-Double ([string]$rest[0]) 0); contrast = (Get-Double ([string]$rest[1]) 0) } } '亮度/对比度调整失败') }
      } elseif ($sub -eq 'hs') {
        if ($rest.Count -lt 2) { Fail '用法: adjust hs <hue> <saturation> [--lightness n]' 'hue -180..180，saturation/lightness -100..100' }
        else {
          $argsH = @{ hue = (Get-Double ([string]$rest[0]) 0); saturation = (Get-Double ([string]$rest[1]) 0) }
          if ($named['lightness']) { $argsH.lightness = Get-Double ([string]$named['lightness']) 0 }
          Finish (Invoke-WithCheck @{ op = 'adjust-hs'; args = $argsH } '色相/饱和度调整失败')
        }
      } else { Fail '未知 adjust 子命令' 'adjust bc|hs' }
    }
    'filter' {
      $sub = if ($pos.Count -gt 0) { $pos[0].ToLowerInvariant() } else { '' }
      $rest = @($pos | Select-Object -Skip 1)
      if ($sub -eq 'gaussian-blur') {
        if ($rest.Count -lt 1) { Fail '用法: filter gaussian-blur <radius>' '像素' }
        else { Finish (Invoke-WithCheck @{ op = 'filter'; args = @{ name = 'gaussian-blur'; radius = (Get-Double ([string]$rest[0]) 1) } } '模糊失败') }
      } elseif ($sub -eq 'unsharp-mask') {
        if ($rest.Count -lt 2) { Fail '用法: filter unsharp-mask <amount> <radius> [--threshold n]' 'amount 1-500，radius 像素' }
        else {
          $argsH = @{ name = 'unsharp-mask'; amount = (Get-Double ([string]$rest[0]) 100); radius = (Get-Double ([string]$rest[1]) 1) }
          if ($named['threshold']) { $argsH.threshold = Get-Double ([string]$named['threshold']) 0 }
          Finish (Invoke-WithCheck @{ op = 'filter'; args = $argsH } '锐化失败')
        }
      } elseif ($sub -eq 'add-noise') {
        if ($rest.Count -lt 1) { Fail '用法: filter add-noise <amount> [--mono]' 'amount 0.1-400' }
        else {
          $argsH = @{ name = 'add-noise'; amount = (Get-Double ([string]$rest[0]) 5) }
          if ($named['mono']) { $argsH.mono = $true }
          Finish (Invoke-WithCheck @{ op = 'filter'; args = $argsH } '加杂色失败')
        }
      } else { Fail '未知 filter 子命令' 'filter gaussian-blur|unsharp-mask|add-noise' }
    }
    'selection' {
      $sub = if ($pos.Count -gt 0) { $pos[0].ToLowerInvariant() } else { '' }
      if ($sub -in @('all', 'none', 'invert')) {
        Finish (Invoke-WithCheck @{ op = 'selection'; args = @{ mode = $sub } } '选区操作失败')
      } else { Fail '用法: selection all|none|invert' '' }
    }
    'flatten' {
      Finish (Invoke-WithCheck @{ op = 'flatten'; args = @{} } '合并失败')
    }
    'eval' {
      if ($pos.Count -lt 1) { Fail '用法: eval "<一行 ExtendScript>"' '例如: eval "app.activeDocument.name"' }
      else { Finish (Invoke-WithCheck @{ op = 'eval'; args = @{ expr = [string]$pos[0] } } 'eval 失败——检查 ExtendScript 语法') }
    }
    'run' {
      if ($pos.Count -lt 1) { Fail '用法: run <script.jsx>' '脚本需自包含（不支持 #include），用 eval 语句执行' }
      else { Finish (Invoke-WithCheck @{ op = 'run'; args = @{ path = [string]$pos[0] } } '脚本执行失败') }
    }
    'batch' {
      if ($pos.Count -lt 2) { Fail '用法: batch <indir> <outdir> [--pattern *.jpg] [--format png] [--quality n] [--ops "<json>"]' '--ops 为操作数组: [{"op":"resize","args":{"width":800,"height":600}},...]' }
      else {
        $indir = [string]$pos[0]
        $outdir = [string]$pos[1]
        if (-not (Test-Path $indir -PathType Container)) { Fail '输入目录不存在' $indir }
        else {
          $null = New-Item -ItemType Directory -Path $outdir -Force
          $pattern = if ($named['pattern']) { [string]$named['pattern'] } else { '*' }
          $fmt = if ($named['format']) { [string]$named['format'] } else { 'png' }
          $quality = if ($named['quality']) { Get-Double ([string]$named['quality']) 10 } else { $null }
          $ops = @()
          if ($named['ops']) {
            try { $ops = @(ConvertFrom-Json ([string]$named['ops'])) }
            catch { Fail '无法解析 --ops JSON' $_.Exception.Message }
          }
          $files = @(Get-ChildItem -Path $indir -File -Filter $pattern)
          if ($files.Count -eq 0) { Fail '没有匹配的文件' "pattern: $pattern" }
          else {
            $results = @()
            foreach ($f in $files) {
              $outPath = Join-Path $outdir ([System.IO.Path]::GetFileNameWithoutExtension($f.Name) + '.' + $fmt)
              $r = @{ input = $f.Name; output = $outPath; ok = $false; error = $null }
              try {
                $res = Invoke-Ps6 @{ op = 'doc-open'; args = @{ path = $f.FullName } }
                if ($res.ok -eq $false) { throw ($res.error + ' | ' + $res.hint) }
                foreach ($op in @($ops)) {
                  $argsMap = @{}
                  if ($op.args) { foreach ($prop in $op.args.PSObject.Properties) { $argsMap[$prop.Name] = $prop.Value } }
                  $res = Invoke-Ps6 @{ op = [string]$op.op; args = $argsMap }
                  if ($res.ok -eq $false) { throw ($res.error + ' | ' + $res.hint) }
                }
                $expArgs = @{ path = $outPath; format = $fmt }
                if ($quality) { $expArgs.quality = $quality }
                $res = Invoke-Ps6 @{ op = 'export'; args = $expArgs }
                if ($res.ok -eq $false) { throw ($res.error + ' | ' + $res.hint) }
                $res = Invoke-Ps6 @{ op = 'doc-close'; args = @{ save = 'no' } }
                if ($res.ok -eq $false) { throw ($res.error + ' | ' + $res.hint) }
                $r.ok = $true
              } catch {
                $r.error = $_.Exception.Message
                try { $null = Invoke-Ps6 @{ op = 'doc-close'; args = @{ save = 'no' } } } catch { }
              }
              $results += $r
            }
            $okCount = @($results | Where-Object { $_.ok }).Count
            Finish @{ ok = $true; data = @{ total = $results.Count; succeeded = $okCount; failed = ($results.Count - $okCount); files = $results } }
          }
        }
      }
    }
    default {
      Fail '未知命令' 'status|selftest|doc|save-as|export|layer|text|resize|canvas|adjust|filter|selection|flatten|batch|eval|run|quit'
      exit 2
    }
  }
} catch {
  Fail '命令执行异常' $_.Exception.Message
}
