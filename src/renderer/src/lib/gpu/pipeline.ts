import { skyMask } from '../../../../shared/develop'
import { BLUR_FRAGMENT, DETAIL_FRAGMENT, IMAGE_FRAGMENT, VERTEX } from './shaders'
import { detailSigma, type GpuParams } from './params'

export interface SourceTexture {
  texture: WebGLTexture
  width: number
  height: number
  fullWidth: number
  fullHeight: number
  bytes: number
}

interface Target {
  texture: WebGLTexture
  framebuffer: WebGLFramebuffer
  width: number
  height: number
}

export interface View {
  /** Bildrahmen im Ziel (Pixel): links, oben, Breite, Höhe. */
  box: [number, number, number, number]
  zoom: number
  pan: [number, number]
}

export interface DrawOptions {
  src: SourceTexture
  params: GpuParams
  /** Zielgröße in Pixeln (Zeichenfläche). */
  width: number
  height: number
  view?: View
  /** Vorher/Nachher: links dieser x-Position (Pixel) das Original. */
  splitX?: number
  original?: boolean
  /** Nur Geometrie, keine Farbe. */
  geometryOnly?: boolean
  /** Details (Klarheit, Schärfen, Rauschen) mitrechnen. */
  detail?: boolean
  /** Weichzeichner-Radius für die Details (Zielpixel). */
  sigma?: number
  /** Sky-Maske (Ausgabebild) vorhanden. */
  skyTexture?: WebGLTexture | null
  /** Ergebnis in einen Zwischenspeicher statt auf die Zeichenfläche (Tests, Auslesen). */
  toTarget?: string
  /** Position im Ziel (Viewport), für Vorschaukacheln. */
  viewport?: [number, number, number, number]
}

type Program = {
  program: WebGLProgram
  uniforms: Record<string, WebGLUniformLocation | null>
}

const BACKGROUND: [number, number, number] = [0x0b / 255, 0x0c / 255, 0x0e / 255]

/**
 * WebGL2-Rechenweg für Vorschau, Look-Kacheln und Histogramm. Das Foto liegt als Textur (einmal hochgeladen),
 * jede Änderung der Regler ist nur noch ein Zeichenaufruf.
 */
export class GpuPipeline {
  readonly gl: WebGL2RenderingContext
  readonly renderer: string
  private image: Program
  private blur: Program
  private detail: Program
  private lutTexture: WebGLTexture
  private emptySky: WebGLTexture
  private targets = new Map<string, Target>()
  private vao: WebGLVertexArrayObject
  lost = false

  static create(canvas: HTMLCanvasElement | OffscreenCanvas): GpuPipeline | null {
    try {
      const gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance'
      }) as WebGL2RenderingContext | null
      if (!gl) return null
      return new GpuPipeline(gl, canvas)
    } catch {
      return null
    }
  }

  private constructor(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.gl = gl
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    this.renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
    this.image = this.compile(IMAGE_FRAGMENT, [
      'uSrc', 'uLut', 'uSky', 'uOut', 'uBox', 'uZoom', 'uPan', 'uSrcDim', 'uSrcCenter', 'uRot', 'uGeoOrigin', 'uGeoExtent', 'uSatMul', 'uVib', 'uKeep',
      'uHsl', 'uHue', 'uSat', 'uLum', 'uSkyOn', 'uSplitX', 'uOriginal', 'uGeoOnly', 'uBg', 'uFlipY'
    ])
    this.blur = this.compile(BLUR_FRAGMENT, ['uTex', 'uDir', 'uSigma', 'uFlipY'])
    this.detail = this.compile(DETAIL_FRAGMENT, ['uColor', 'uBlur', 'uClarity', 'uSharpen', 'uNoise', 'uFlipY'])
    this.vao = gl.createVertexArray() as WebGLVertexArrayObject
    this.lutTexture = this.makeTexture(256, 1, gl.RGBA8, gl.RGBA, null, gl.NEAREST)
    this.emptySky = this.makeTexture(1, 1, gl.R8, gl.RED, new Uint8Array([0]), gl.LINEAR)
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault()
      this.lost = true
    })
  }

  private compile(fragment: string, names: string[]): Program {
    const gl = this.gl
    const make = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type) as WebGLShader
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`Shader: ${gl.getShaderInfoLog(shader) ?? 'Fehler'}`)
      }
      return shader
    }
    const program = gl.createProgram() as WebGLProgram
    gl.attachShader(program, make(gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(program, make(gl.FRAGMENT_SHADER, fragment))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Programm: ${gl.getProgramInfoLog(program) ?? 'Fehler'}`)
    }
    const uniforms: Record<string, WebGLUniformLocation | null> = {}
    for (const name of names) uniforms[name] = gl.getUniformLocation(program, name)
    // Feldnamen (uHue[0]) für Arrays
    for (const name of ['uHue', 'uSat', 'uLum']) {
      if (names.includes(name)) uniforms[name] = gl.getUniformLocation(program, `${name}[0]`)
    }
    return { program, uniforms }
  }

  private makeTexture(
    width: number,
    height: number,
    internal: number,
    format: number,
    data: ArrayBufferView | null,
    filter: number
  ): WebGLTexture {
    const gl = this.gl
    const texture = gl.createTexture() as WebGLTexture
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, gl.UNSIGNED_BYTE, data)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return texture
  }

  /** Rohes RGB-Foto als Textur hochladen (mit Mip-Stufen für saubere Verkleinerung). */
  upload(raw: { data: Uint8Array; width: number; height: number; fullWidth?: number; fullHeight?: number }): SourceTexture {
    const gl = this.gl
    const texture = gl.createTexture() as WebGLTexture
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, raw.width, raw.height, 0, gl.RGB, gl.UNSIGNED_BYTE, raw.data)
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return {
      texture,
      width: raw.width,
      height: raw.height,
      fullWidth: raw.fullWidth ?? raw.width,
      fullHeight: raw.fullHeight ?? raw.height,
      bytes: Math.round(raw.width * raw.height * 4 * 1.34)
    }
  }

  release(source: SourceTexture): void {
    this.gl.deleteTexture(source.texture)
  }

  private target(name: string, width: number, height: number): Target {
    const gl = this.gl
    const existing = this.targets.get(name)
    if (existing && existing.width === width && existing.height === height) return existing
    if (existing) {
      gl.deleteTexture(existing.texture)
      gl.deleteFramebuffer(existing.framebuffer)
    }
    const texture = this.makeTexture(width, height, gl.RGBA8, gl.RGBA, null, gl.NEAREST)
    const framebuffer = gl.createFramebuffer() as WebGLFramebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    const made = { texture, framebuffer, width, height }
    this.targets.set(name, made)
    return made
  }

  private bind(unit: number, texture: WebGLTexture): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, texture)
  }

  private fill(width: number, height: number, framebuffer: WebGLFramebuffer | null, viewport?: [number, number, number, number]): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    if (viewport) gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3])
    else gl.viewport(0, 0, width, height)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(this.vao)
  }

  /** Zeichnet das Bild: Geometrie, Farbe und (falls nötig) Details; Ziel ist die Zeichenfläche oder ein Zwischenspeicher. */
  draw(options: DrawOptions): void {
    const gl = this.gl
    const { src, params, width, height } = options
    const flip = options.toTarget ? 1 : 0
    const wantDetail = options.detail !== false && params.detail && !options.geometryOnly && !options.original
    const view: View = options.view ?? { box: [0, 0, width, height], zoom: 1, pan: [0, 0] }
    const imageDest = wantDetail ? this.target('color', width, height) : options.toTarget ? this.target(options.toTarget, width, height) : null

    // 1) Geometrie + Farbe
    const image = this.image
    gl.useProgram(image.program)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, params.lut)
    this.bind(0, src.texture)
    this.bind(2, options.skyTexture ?? this.emptySky)
    const u = image.uniforms
    gl.uniform1i(u.uSrc, 0)
    gl.uniform1i(u.uLut, 1)
    gl.uniform1i(u.uSky, 2)
    gl.uniform2f(u.uOut, width, height)
    gl.uniform4f(u.uBox, view.box[0], view.box[1], view.box[2], view.box[3])
    gl.uniform1f(u.uZoom, view.zoom)
    gl.uniform2f(u.uPan, view.pan[0], view.pan[1])
    gl.uniform2f(u.uSrcDim, src.width, src.height)
    gl.uniformMatrix2fv(u.uRot, false, params.rot)
    gl.uniform2f(u.uSrcCenter, params.srcCenter[0], params.srcCenter[1])
    gl.uniform2f(u.uGeoOrigin, params.origin[0], params.origin[1])
    gl.uniform2f(u.uGeoExtent, params.extent[0], params.extent[1])
    gl.uniform1f(u.uSatMul, params.satMul)
    gl.uniform1f(u.uVib, params.vib)
    gl.uniform1f(u.uKeep, params.keep)
    gl.uniform1f(u.uHsl, params.hsl ? 1 : 0)
    gl.uniform1fv(u.uHue, params.hue)
    gl.uniform1fv(u.uSat, params.sat)
    gl.uniform1fv(u.uLum, params.lum)
    gl.uniform1f(u.uSkyOn, options.skyTexture ? 1 : 0)
    gl.uniform1f(u.uSplitX, options.splitX ?? -1)
    gl.uniform1f(u.uOriginal, options.original ? 1 : 0)
    gl.uniform1f(u.uGeoOnly, options.geometryOnly ? 1 : 0)
    gl.uniform3f(u.uBg, BACKGROUND[0], BACKGROUND[1], BACKGROUND[2])
    gl.uniform1f(u.uFlipY, flip)
    this.fill(width, height, imageDest ? imageDest.framebuffer : null, imageDest ? undefined : options.viewport)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    if (!wantDetail) return

    // 2) Weichzeichnen (waagerecht, senkrecht)
    const sigma = options.sigma ?? detailSigma(width, height)
    const blurA = this.target('blurA', width, height)
    const blurB = this.target('blurB', width, height)
    gl.useProgram(this.blur.program)
    gl.uniform1f(this.blur.uniforms.uSigma, sigma)
    gl.uniform1f(this.blur.uniforms.uFlipY, flip)
    gl.uniform1i(this.blur.uniforms.uTex, 0)
    gl.uniform2f(this.blur.uniforms.uDir, 1, 0)
    this.bind(0, (imageDest as Target).texture)
    this.fill(width, height, blurA.framebuffer)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.uniform2f(this.blur.uniforms.uDir, 0, 1)
    this.bind(0, blurA.texture)
    this.fill(width, height, blurB.framebuffer)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // 3) Details zusammenführen
    const dest = options.toTarget ? this.target(options.toTarget, width, height) : null
    gl.useProgram(this.detail.program)
    gl.uniform1i(this.detail.uniforms.uColor, 0)
    gl.uniform1i(this.detail.uniforms.uBlur, 1)
    gl.uniform1f(this.detail.uniforms.uClarity, params.clarity)
    gl.uniform1f(this.detail.uniforms.uSharpen, params.sharpen)
    gl.uniform1f(this.detail.uniforms.uNoise, params.noise)
    gl.uniform1f(this.detail.uniforms.uFlipY, flip)
    this.bind(0, (imageDest as Target).texture)
    this.bind(1, blurB.texture)
    this.fill(width, height, dest ? dest.framebuffer : null, dest ? undefined : options.viewport)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /** Liest einen Zwischenspeicher als RGBA (oberste Zeile zuerst). */
  read(name: string, width: number, height: number): Uint8Array {
    const gl = this.gl
    const target = this.target(name, width, height)
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
    const pixels = new Uint8Array(width * height * 4)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    return pixels
  }

  /** Wartet, bis die Grafikkarte fertig ist (für Messungen). */
  finish(): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.finish()
  }

  /**
   * Himmelsmaske wie auf der CPU: Bild klein (lange Kante 192) rechnen, Maske bestimmen, als Textur hochladen.
   * Gibt null zurück, wenn kein Himmel gefunden wurde.
   */
  buildSky(src: SourceTexture, params: GpuParams): WebGLTexture | null {
    const long = 192
    const ratio = params.outWidth / params.outHeight
    const width = ratio >= 1 ? long : Math.max(1, Math.round(long * ratio))
    const height = ratio >= 1 ? Math.max(1, Math.round(long / ratio)) : long
    this.draw({ src, params, width, height, geometryOnly: true, toTarget: 'sky' })
    const rgba = this.read('sky', width, height)
    const rgb = new Uint8Array(width * height * 3)
    for (let index = 0, out = 0; index < rgba.length; index += 4, out += 3) {
      rgb[out] = rgba[index]
      rgb[out + 1] = rgba[index + 1]
      rgb[out + 2] = rgba[index + 2]
    }
    const mask = skyMask(rgb, width, height)
    if (!mask) return null
    return this.makeTexture(width, height, this.gl.R8, this.gl.RED, mask, this.gl.LINEAR)
  }

  deleteTexture(texture: WebGLTexture | null): void {
    if (texture) this.gl.deleteTexture(texture)
  }

  /** Histogramm (48 Klassen der Helligkeit) wie auf der CPU, aus einer kleinen Berechnung. */
  histogram(src: SourceTexture, params: GpuParams, sky: WebGLTexture | null): number[] {
    const long = 256
    const ratio = params.outWidth / params.outHeight
    const width = ratio >= 1 ? long : Math.max(1, Math.round(long * ratio))
    const height = ratio >= 1 ? Math.max(1, Math.round(long / ratio)) : long
    this.draw({ src, params, width, height, detail: false, skyTexture: sky, toTarget: 'hist' })
    const rgba = this.read('hist', width, height)
    const bins = new Array<number>(48).fill(0)
    for (let index = 0; index < rgba.length; index += 4) {
      const lum = (0.2126 * rgba[index] + 0.7152 * rgba[index + 1] + 0.0722 * rgba[index + 2]) / 255
      bins[Math.min(47, Math.max(0, Math.round(lum * 47)))] += 1
    }
    const peak = bins.reduce((max, value) => Math.max(max, value), 1)
    return bins.map((value) => value / peak)
  }

  /**
   * Alle Look-Kacheln in einem Durchgang: je Look ein Kästchen in einem Atlas, danach ein einziges Auslesen
   * (oberste Zeile zuerst). `tiles` liefert Regler und Himmelsmaske je Kachel (Look bereits eingerechnet).
   */
  renderTiles(
    src: SourceTexture,
    tiles: { params: GpuParams; sky: WebGLTexture | null }[],
    tileWidth: number,
    tileHeight: number,
    columns: number
  ): { pixels: Uint8Array; width: number; height: number } {
    const rows = Math.ceil(tiles.length / columns)
    const width = tileWidth * columns
    const height = tileHeight * rows
    const gl = this.gl
    const atlas = this.target('atlas', width, height)
    tiles.forEach((entry, index) => {
      const column = index % columns
      const row = Math.floor(index / columns)
      this.drawTile(src, entry.params, entry.sky, tileWidth, tileHeight, [column * tileWidth, row * tileHeight, tileWidth, tileHeight], atlas)
    })
    gl.bindFramebuffer(gl.FRAMEBUFFER, atlas.framebuffer)
    const pixels = new Uint8Array(width * height * 4)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    return { pixels, width, height }
  }

  private drawTile(
    src: SourceTexture,
    params: GpuParams,
    sky: WebGLTexture | null,
    width: number,
    height: number,
    viewport: [number, number, number, number],
    atlas: Target
  ): void {
    const gl = this.gl
    const image = this.image
    gl.useProgram(image.program)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, params.lut)
    this.bind(0, src.texture)
    this.bind(2, sky ?? this.emptySky)
    const u = image.uniforms
    gl.uniform1i(u.uSrc, 0)
    gl.uniform1i(u.uLut, 1)
    gl.uniform1i(u.uSky, 2)
    gl.uniform2f(u.uOut, width, height)
    // Kachel füllen wie object-cover: Bildrahmen größer als die Kachel.
    const cover = Math.max(width / params.outWidth, height / params.outHeight)
    const boxW = params.outWidth * cover
    const boxH = params.outHeight * cover
    gl.uniform4f(u.uBox, (width - boxW) / 2, (height - boxH) / 2, boxW, boxH)
    gl.uniform1f(u.uZoom, 1)
    gl.uniform2f(u.uPan, 0, 0)
    gl.uniform2f(u.uSrcDim, src.width, src.height)
    gl.uniformMatrix2fv(u.uRot, false, params.rot)
    gl.uniform2f(u.uSrcCenter, params.srcCenter[0], params.srcCenter[1])
    gl.uniform2f(u.uGeoOrigin, params.origin[0], params.origin[1])
    gl.uniform2f(u.uGeoExtent, params.extent[0], params.extent[1])
    gl.uniform1f(u.uSatMul, params.satMul)
    gl.uniform1f(u.uVib, params.vib)
    gl.uniform1f(u.uKeep, params.keep)
    gl.uniform1f(u.uHsl, params.hsl ? 1 : 0)
    gl.uniform1fv(u.uHue, params.hue)
    gl.uniform1fv(u.uSat, params.sat)
    gl.uniform1fv(u.uLum, params.lum)
    gl.uniform1f(u.uSkyOn, sky ? 1 : 0)
    gl.uniform1f(u.uSplitX, -1)
    gl.uniform1f(u.uOriginal, 0)
    gl.uniform1f(u.uGeoOnly, 0)
    gl.uniform3f(u.uBg, BACKGROUND[0], BACKGROUND[1], BACKGROUND[2])
    gl.uniform1f(u.uFlipY, 1)
    gl.bindFramebuffer(gl.FRAMEBUFFER, atlas.framebuffer)
    // Mit uFlipY entspricht die GL-Zeile der Zeile von oben beim Auslesen.
    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3])
    gl.disable(gl.BLEND)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
}
