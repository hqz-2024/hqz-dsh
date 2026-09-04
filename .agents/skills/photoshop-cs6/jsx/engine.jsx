// engine.jsx — operation engine for the photoshop-cs6 skill.
// Runs inside Photoshop CS6 via DoJavaScriptFile. Pure ASCII source for
// parser compatibility; every operation returns a payload serialized by
// helpers.jsx. The driver file ps6.ps1 generates includes this file after
// lib/helpers.jsx (absolute includes) and then calls ps6Execute(req, resultPath).
#include "lib/helpers.jsx"

// ---- small utilities --------------------------------------------------------

function num(v) {
  var n = Number(v)
  return (isFinite(n) && n > 0) ? n : null
}

function numOr(v, def) {
  var n = Number(v)
  return isFinite(n) ? n : def
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

function ps6Doc() {
  if (app.documents.length === 0) throw new Error('no open document')
  return app.activeDocument
}

function countLayers(container) {
  var n = 0
  for (var i = 0; i < container.layers.length; i++) {
    var l = container.layers[i]
    n += l.typename === 'LayerSet' ? 1 + countLayers(l) : 1
  }
  return n
}

function findLayer(container, name) {
  for (var i = 0; i < container.layers.length; i++) {
    var l = container.layers[i]
    if (l.name === name) return l
    if (l.typename === 'LayerSet') {
      var f = findLayer(l, name)
      if (f) return f
    }
  }
  return null
}

function hexColor(h) {
  var m = /^#?([0-9a-fA-F]{6})$/.exec(String(h))
  if (!m) throw new Error('color must be #RRGGBB: ' + h)
  var n = parseInt(m[1], 16)
  var c = new SolidColor()
  c.rgb.red = (n >> 16) & 255
  c.rgb.green = (n >> 8) & 255
  c.rgb.blue = n & 255
  return c
}

function anchorFor(s) {
  var map = {
    tl: AnchorPosition.TOPLEFT, tc: AnchorPosition.TOPCENTER, tr: AnchorPosition.TOPRIGHT,
    ml: AnchorPosition.MIDDLELEFT, mc: AnchorPosition.MIDDLECENTER, mr: AnchorPosition.MIDDLERIGHT,
    bl: AnchorPosition.BOTTOMLEFT, bc: AnchorPosition.BOTTOMCENTER, br: AnchorPosition.BOTTOMRIGHT,
  }
  var k = String(s || 'mc').toLowerCase()
  if (!map[k]) throw new Error('anchor must be one of tl/tc/tr/ml/mc/mr/bl/bc/br')
  return map[k]
}

function unlockBackground(d) {
  var l = d.activeLayer
  if (l.isBackgroundLayer === true) l.isBackgroundLayer = false
}

// ---- operations --------------------------------------------------------------

function opStatus() {
  var docs = []
  for (var i = 0; i < app.documents.length; i++) {
    var d = app.documents[i]
    docs.push({
      name: d.name,
      width: Math.round(d.width.as('px')),
      height: Math.round(d.height.as('px')),
      mode: d.mode.toString(),
      saved: d.saved,
      layers: countLayers(d),
    })
  }
  return ps6Ok({ version: app.version, name: app.name, documents: docs })
}

function opDocInfo() {
  var d = ps6Doc()
  var layers = []
  for (var i = 0; i < d.layers.length; i++) {
    var l = d.layers[i]
    layers.push({
      name: l.name,
      index: i,
      kind: l.typename === 'LayerSet' ? 'group' : String(l.kind),
      visible: l.visible,
      opacity: Math.round(l.opacity),
    })
  }
  return ps6Ok({
    name: d.name,
    width: Math.round(d.width.as('px')),
    height: Math.round(d.height.as('px')),
    mode: d.mode.toString(),
    saved: d.saved,
    resolution: Math.round(d.resolution),
    activeLayer: d.activeLayer ? d.activeLayer.name : null,
    layers: layers,
  })
}

function opDocNew(a) {
  var w = num(a.width)
  var h = num(a.height)
  if (!w || !h) throw new Error('width/height must be positive pixel numbers')
  var bg = String(a.bg || 'white').toLowerCase()
  var isHex = bg.charAt(0) === '#'
  var fill = bg === 'transparent' ? DocumentFill.TRANSPARENT : DocumentFill.WHITE
  var d = app.documents.add(w, h, 72, a.name || 'Untitled', NewDocumentMode.RGB, fill)
  if (isHex) {
    d.selection.selectAll()
    d.selection.fill(hexColor(bg))
    d.selection.deselect()
  }
  return ps6Ok({ name: d.name, width: w, height: h, background: bg })
}

function opDocOpen(a) {
  if (!a.path) throw new Error('path is required')
  var d = app.open(File(ps6Path(a.path)))
  return ps6Ok({
    name: d.name,
    width: Math.round(d.width.as('px')),
    height: Math.round(d.height.as('px')),
  })
}

function opDocClose(a) {
  var d = ps6Doc()
  var name = d.name
  var save = a.save === 'yes'
  d.close(save ? SaveOptions.SAVECHANGES : SaveOptions.DONOTSAVECHANGES)
  return ps6Ok({ closed: name, saved: save })
}

function opDocActivate(a) {
  var d
  if (a.index != null) {
    var i = Number(a.index)
    if (i < 0 || i >= app.documents.length) throw new Error('document index out of range (0-based)')
    d = app.documents[i]
  } else if (a.name) {
    d = app.documents.getByName(String(a.name))
  } else {
    throw new Error('name or index is required')
  }
  app.activeDocument = d
  return ps6Ok({ name: d.name })
}

function opSaveAs(a) {
  var d = ps6Doc()
  var fmt = String(a.format || 'psd').toLowerCase()
  var opts
  if (fmt === 'psd') opts = new PhotoshopSaveOptions()
  else if (fmt === 'png') {
    opts = new PNGSaveOptions()
    if (a.compression != null) opts.compression = clamp(Number(a.compression), 0, 9)
  } else if (fmt === 'jpg' || fmt === 'jpeg') {
    opts = new JPEGSaveOptions()
    opts.quality = a.quality != null ? clamp(Number(a.quality), 1, 12) : 10
    opts.embedColorProfile = false
  } else if (fmt === 'tiff' || fmt === 'tif') opts = new TiffSaveOptions()
  else if (fmt === 'bmp') opts = new BMPSaveOptions()
  else throw new Error('unsupported format: ' + fmt + ' (psd/png/jpg/tiff/bmp)')
  var path = ps6Path(a.path)
  d.saveAs(File(path), opts, true, Extension.LOWERCASE)
  return ps6Ok({ path: path, format: fmt })
}

function opExport(a) {
  var d = ps6Doc()
  var fmt = String(a.format || 'png').toLowerCase()
  var path = ps6Path(a.path)
  if (fmt === 'gif') {
    var o = new ExportOptionsSaveForWeb()
    o.format = SaveDocumentType.COMPUSERVEGIF
    o.colors = a.colors != null ? clamp(Number(a.colors), 2, 256) : 256
    d.exportDocument(File(path), ExportType.SAVEFORWEB, o)
  } else {
    return opSaveAs({ path: path, format: fmt, quality: a.quality, compression: a.compression })
  }
  return ps6Ok({ path: path, format: fmt })
}

function opLayerAdd(a) {
  var d = ps6Doc()
  var kind = String(a.kind || 'empty').toLowerCase()
  var l
  if (kind === 'text') {
    l = d.artLayers.add()
    l.kind = LayerKind.TEXT
    if (!l.textItem.contents) l.textItem.contents = ' '
  } else if (kind === 'group') {
    l = d.layerSets.add()
  } else {
    l = d.artLayers.add()
  }
  if (a.name) l.name = String(a.name)
  if (a.opacity != null) l.opacity = clamp(Number(a.opacity), 0, 100)
  return ps6Ok({ name: l.name, kind: l.typename })
}

function opLayerSelect(a) {
  var d = ps6Doc()
  var l
  if (a.index != null) {
    var i = Number(a.index)
    if (i < 0 || i >= d.layers.length) throw new Error('layer index out of range (0-based)')
    l = d.layers[i]
  } else if (a.name) {
    l = findLayer(d, String(a.name))
    if (!l) throw new Error('layer not found: ' + a.name)
  } else {
    throw new Error('name or index is required')
  }
  d.activeLayer = l
  return ps6Ok({ name: l.name })
}

function opLayerRemove(a) {
  var d = ps6Doc()
  var l
  if (a.index != null) {
    var i = Number(a.index)
    if (i < 0 || i >= d.layers.length) throw new Error('layer index out of range (0-based)')
    l = d.layers[i]
  } else if (a.name) {
    l = findLayer(d, String(a.name))
    if (!l) throw new Error('layer not found: ' + a.name)
  } else {
    throw new Error('name or index is required')
  }
  var removed = l.name
  l.remove()
  return ps6Ok({ removed: removed })
}

function opLayerRename(a) {
  var d = ps6Doc()
  var old = d.activeLayer.name
  d.activeLayer.name = String(a.newname)
  return ps6Ok({ from: old, to: d.activeLayer.name })
}

function opLayerVisibility(a) {
  var d = ps6Doc()
  var v = a.visible === true || a.visible === 'true' || a.visible === 'on'
  d.activeLayer.visible = v
  return ps6Ok({ name: d.activeLayer.name, visible: v })
}

function opLayerTranslate(a) {
  var d = ps6Doc()
  var dx = numOr(a.dx, 0)
  var dy = numOr(a.dy, 0)
  d.activeLayer.translate(dx, dy)
  return ps6Ok({ name: d.activeLayer.name, moved: [dx, dy] })
}

function opTextAdd(a) {
  var d = ps6Doc()
  var l = d.artLayers.add()
  l.kind = LayerKind.TEXT
  var t = l.textItem
  t.contents = a.text != null ? String(a.text) : ''
  if (a.font) t.font = String(a.font)
  if (a.size != null) t.size = Number(a.size)
  if (a.color) t.color = hexColor(a.color)
  if (a.bold != null) t.fauxBold = a.bold === true || a.bold === 'true'
  if (a.x != null || a.y != null) {
    if (a.x == null || a.y == null) throw new Error('x and y must be provided together')
    t.position = [Number(a.x), Number(a.y)]
  }
  return ps6Ok({ name: l.name, text: t.contents, font: t.font, size: Math.round(Number(t.size)) })
}

function opTextSet(a) {
  var d = ps6Doc()
  var l = d.activeLayer
  if (l.kind !== LayerKind.TEXT) throw new Error('active layer is not a text layer')
  var t = l.textItem
  if (a.text != null) t.contents = String(a.text)
  if (a.font) t.font = String(a.font)
  if (a.size != null) t.size = Number(a.size)
  if (a.color) t.color = hexColor(a.color)
  if (a.bold != null) t.fauxBold = a.bold === true || a.bold === 'true'
  return ps6Ok({ name: l.name, text: t.contents, font: t.font, size: Math.round(Number(t.size)) })
}

function opResize(a) {
  var d = ps6Doc()
  var w = num(a.width)
  var h = num(a.height)
  if (!w || !h) throw new Error('width/height must be positive pixel numbers')
  d.resizeImage(w, h, d.resolution, ResampleMethod.BICUBIC)
  return ps6Ok({ width: Math.round(d.width.as('px')), height: Math.round(d.height.as('px')) })
}

function opCanvas(a) {
  var d = ps6Doc()
  var w = num(a.width)
  var h = num(a.height)
  if (!w || !h) throw new Error('width/height must be positive pixel numbers')
  d.resizeCanvas(w, h, anchorFor(a.anchor))
  return ps6Ok({ width: Math.round(d.width.as('px')), height: Math.round(d.height.as('px')) })
}

function opAdjustBc(a) {
  var d = ps6Doc()
  unlockBackground(d)
  var b = numOr(a.brightness, 0)
  var c = numOr(a.contrast, 0)
  d.activeLayer.adjustBrightnessContrast(b, c)
  return ps6Ok({ brightness: b, contrast: c })
}

function opAdjustHs(a) {
  var d = ps6Doc()
  unlockBackground(d)
  var h = numOr(a.hue, 0)
  var s = numOr(a.saturation, 0)
  var l = numOr(a.lightness, 0)
  d.activeLayer.adjustHueSaturation(h, s, l)
  return ps6Ok({ hue: h, saturation: s, lightness: l })
}

function opFilter(a) {
  var d = ps6Doc()
  unlockBackground(d)
  var l = d.activeLayer
  var name = String(a.name || '').toLowerCase()
  if (name === 'gaussian-blur' || name === 'gaussianblur' || name === 'blur') {
    l.applyGaussianBlur(numOr(a.radius, 1))
  } else if (name === 'unsharp-mask' || name === 'usm') {
    l.applyUnSharpMask(numOr(a.amount, 100), numOr(a.radius, 1), numOr(a.threshold, 0))
  } else if (name === 'add-noise' || name === 'noise') {
    l.applyAddNoise(numOr(a.amount, 5), NoiseDistribution.GAUSSIAN, a.mono === true || a.mono === 'true')
  } else {
    throw new Error('unsupported filter: ' + name + ' (gaussian-blur/unsharp-mask/add-noise)')
  }
  return ps6Ok({ filter: name })
}

function opSelection(a) {
  var d = ps6Doc()
  var m = String(a.mode || 'all').toLowerCase()
  if (m === 'all') d.selection.selectAll()
  else if (m === 'none' || m === 'deselect') d.selection.deselect()
  else if (m === 'invert') d.selection.invert()
  else throw new Error('mode must be all/none/invert')
  return ps6Ok({ selection: m })
}

function opFlatten() {
  var d = ps6Doc()
  var hidden = []
  for (var i = 0; i < d.layers.length; i++) {
    if (!d.layers[i].visible) hidden.push(d.layers[i].name)
  }
  d.flatten()
  return ps6Ok({ flattened: true, droppedHiddenLayers: hidden })
}

function opEval(a) {
  if (a.expr == null) throw new Error('expr is required')
  var v = eval(String(a.expr))
  return ps6Ok({ value: v })
}

function opRun(a) {
  if (!a.path) throw new Error('path is required')
  var f = File(ps6Path(a.path))
  if (!f.exists) throw new Error('script not found: ' + a.path)
  f.encoding = 'UTF-8'
  f.open('r')
  var src = f.read()
  f.close()
  if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1)
  var v = eval(src)
  return ps6Ok({ value: v })
}

function opSelftest(a) {
  var d = app.documents.add(640, 400, 72, 'ps6-selftest', NewDocumentMode.RGB, DocumentFill.WHITE)
  var l = d.artLayers.add()
  l.kind = LayerKind.TEXT
  var t = l.textItem
  t.contents = a.text || 'PS6 selftest 123'
  t.size = 48
  t.font = 'SimSun'
  t.position = [40, 160]
  var c = new SolidColor()
  c.rgb.red = 220
  c.rgb.green = 30
  c.rgb.blue = 30
  t.color = c
  var path = ps6Path(a.pngPath)
  d.saveAs(File(path), new PNGSaveOptions(), true, Extension.LOWERCASE)
  var payload = ps6Ok({ exported: path, width: 640, height: 400, text: t.contents, font: t.font })
  d.close(SaveOptions.DONOTSAVECHANGES)
  return payload
}

// ---- entry point -------------------------------------------------------------

function ps6Execute(req, resultPath) {
  var origUnits = app.preferences.rulerUnits
  var origTypeUnits = app.preferences.typeUnits
  app.preferences.rulerUnits = Units.PIXELS
  app.preferences.typeUnits = TypeUnits.PIXELS
  app.displayDialogs = DialogModes.NO
  var out
  try {
    var fns = {
      'status': opStatus,
      'doc-info': opDocInfo,
      'doc-new': opDocNew,
      'doc-open': opDocOpen,
      'doc-close': opDocClose,
      'doc-activate': opDocActivate,
      'save-as': opSaveAs,
      'export': opExport,
      'layer-add': opLayerAdd,
      'layer-select': opLayerSelect,
      'layer-remove': opLayerRemove,
      'layer-rename': opLayerRename,
      'layer-visibility': opLayerVisibility,
      'layer-translate': opLayerTranslate,
      'text-add': opTextAdd,
      'text-set': opTextSet,
      'resize': opResize,
      'canvas': opCanvas,
      'adjust-bc': opAdjustBc,
      'adjust-hs': opAdjustHs,
      'filter': opFilter,
      'selection': opSelection,
      'flatten': opFlatten,
      'eval': opEval,
      'run': opRun,
      'selftest': opSelftest,
    }
    var fn = fns[String(req.op || '')]
    if (!fn) throw new Error('unknown operation: ' + req.op)
    out = fn(req.args || {})
  } catch (e) {
    out = ps6Error(e, '')
  }
  try {
    app.preferences.rulerUnits = origUnits
    app.preferences.typeUnits = origTypeUnits
  } catch (e2) { /* restore failure must not mask the payload */ }
  ps6WriteResult(resultPath, out)
}
