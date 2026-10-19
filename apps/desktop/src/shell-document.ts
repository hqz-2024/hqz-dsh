/**
 * Shell-owned documents served over the `dsh-app:` scheme.
 *
 * The update dialog and the mandatory-update window are ordinary HTML documents
 * the shell ships in `renderer/`; serving them is the only reason this scheme
 * answers anything besides `app`. The handler was removed with the standalone
 * plugin manager while both callers and their assets stayed, so it lives here
 * again as its own unit rather than inside the main process.
 * @module shell-document
 */

import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { app } from 'electron'

/** Content types for the assets the shell ships; anything else is opaque bytes. */
const MIME: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

/**
 * Serve one shell document or asset from the packaged `renderer` directory.
 *
 * The path is decoded before containment is checked so an encoded traversal is
 * rejected rather than normalized away, and the containment test compares
 * resolved absolute paths — a prefix test on the URL would accept
 * `renderer/../main.js`. Read failures answer 404 rather than throwing: a
 * missing asset is a page-local failure, and the caller is a protocol handler
 * with no recovery path of its own.
 * @param request - the `dsh-app://shell/…` request.
 * @returns the asset response, or 400/403/404/405 for a request this handler refuses.
 */
export async function serveShellDocument(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
  const root = resolve(app.getAppPath(), 'renderer')
  const url = new URL(request.url)
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return new Response(null, { status: 400 })
  }
  const target = resolve(normalize(join(root, pathname)))
  if (target !== root && !target.startsWith(root + sep)) return new Response(null, { status: 403 })
  try {
    const body = request.method === 'HEAD' ? null : await readFile(target)
    return new Response(body, { headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' } })
  } catch {
    return new Response(null, { status: 404 })
  }
}
