/**
 * Fragment-Shader der Grafikkarten-Vorschau. Gleiche Rechnung wie die CPU-Engine (process.ts):
 * Geometrie (Drehen, Begradigen, Zuschnitt) → Kennlinien je Kanal (Belichtung, Weißabgleich, Lichter, Tiefen,
 * Kontrast, Weiß, Schwarz; als 256er-Tabelle, Eingang 8 Bit wie auf der CPU) → HSL in 8 Farbbereichen →
 * Sättigung/Dynamik mit Hautschutz → Himmelsmaske → (zweiter Durchgang) Klarheit, Schärfen, Rauschen.
 */

export const VERTEX = `#version 300 es
precision highp float;
uniform float uFlipY;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); // 0..2
  vUv = vec2(p.x, p.y) ;
  vec2 clip = p * 2.0 - 1.0;
  // vUv.y = 0 ist die obere Bildkante. Ohne uFlipY liegt sie oben im Zielpuffer (Anzeige),
  // mit uFlipY in Zeile 0 (Auslesen von oben nach unten).
  gl_Position = vec4(clip.x, uFlipY > 0.5 ? clip.y : -clip.y, 0.0, 1.0);
}
`

export const IMAGE_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uSrc;
uniform sampler2D uLut;   // 256x1: R = Kennlinie rot, G = grün, B = blau (0..1)
uniform sampler2D uSky;   // Himmelsmaske (Ausgabebild), nur bei uSkyOn
uniform vec2 uOut;        // Zielgröße in Pixeln
uniform vec4 uBox;        // Bildrahmen im Ziel: links, oben, Breite, Höhe
uniform float uZoom;
uniform vec2 uPan;
uniform vec2 uSrcDim;     // Quellgröße in Pixeln
uniform vec2 uSrcCenter;  // Quellposition der Leinwandmitte (Pixel)
uniform mat2 uRot;        // Ausgabe-Koordinaten (Mitte = 0) -> Quell-Koordinaten (Mitte = 0)
uniform vec2 uGeoOrigin;  // Ausschnitt: Ecke auf der gedrehten Leinwand, bezogen auf deren Mitte (Pixel)
uniform vec2 uGeoExtent;  // Ausschnitt: Größe in Pixeln
uniform float uSatMul;
uniform float uVib;
uniform float uKeep;      // 1 - Schwarzweiß
uniform float uHsl;
uniform float uHue[8];
uniform float uSat[8];
uniform float uLum[8];
uniform float uSkyOn;
uniform float uSplitX;    // Vorher/Nachher: links davon Original (-1 = aus)
uniform float uOriginal;  // 1 = überall Original
uniform float uGeoOnly;   // 1 = nur Geometrie (Himmelsmaske)
uniform vec3 uBg;

in vec2 vUv;
out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float sstep(float e0, float e1, float x) {
  float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

float bandValue(float values[8], float hue) {
  float h = mod(hue, 360.0);
  float centers[9] = float[9](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0, 360.0);
  for (int i = 0; i < 8; i++) {
    if (h >= centers[i] && h < centers[i + 1]) {
      float t = (h - centers[i]) / (centers[i + 1] - centers[i]);
      t = t * t * (3.0 - 2.0 * t);
      return values[i] * (1.0 - t) + values[(i + 1) % 8] * t;
    }
  }
  return values[0];
}

float hueChannel(float p, float q, float t0) {
  float t = t0;
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}

vec3 adjustHsl(vec3 c) {
  float maxC = max(c.r, max(c.g, c.b));
  float minC = min(c.r, min(c.g, c.b));
  float l = (maxC + minC) * 0.5;
  float d = maxC - minC;
  if (d < 0.000001) return c;
  float s = l > 0.5 ? d / (2.0 - maxC - minC) : d / (maxC + minC);
  float h;
  if (maxC == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (maxC == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  h *= 60.0;
  float gate = sstep(0.03, 0.18, s);
  if (gate <= 0.0) return c;
  float hueShift = (bandValue(uHue, h) / 100.0) * 30.0;
  float satShift = bandValue(uSat, h) / 100.0;
  float lumShift = bandValue(uLum, h) / 100.0;
  h += hueShift * gate;
  if (h < 0.0) h += 360.0;
  if (h >= 360.0) h -= 360.0;
  s *= 1.0 + satShift * gate;
  if (lumShift > 0.0) l += lumShift * 0.4 * gate * (1.0 - l) * s;
  else l += lumShift * 0.4 * gate * l * s;
  s = clamp(s, 0.0, 1.0);
  l = clamp(l, 0.0, 1.0);
  if (s < 0.000001) return vec3(l);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  float hk = h / 360.0;
  return vec3(hueChannel(p, q, hk + 1.0 / 3.0), hueChannel(p, q, hk), hueChannel(p, q, hk - 1.0 / 3.0));
}

float skinWeight(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float delta = mx - mn;
  if (delta < 0.045 || mx == 0.0) return 0.0;
  float hue;
  if (mx == c.r) hue = mod((c.g - c.b) / delta, 6.0);
  else if (mx == c.g) hue = (c.b - c.r) / delta + 2.0;
  else hue = (c.r - c.g) / delta + 4.0;
  if (hue < 0.0) hue += 6.0;
  float hueUnit = hue / 6.0;
  float saturation = delta / mx;
  float lum = dot(c, LUMA);
  bool skinHue = hueUnit < 0.11 || hueUnit > 0.97;
  if (!skinHue || saturation < 0.14 || saturation > 0.72 || lum < 0.2 || lum > 0.9) return 0.0;
  return 0.72;
}

vec3 lutApply(vec3 c) {
  ivec3 q = ivec3(floor(clamp(c, 0.0, 1.0) * 255.0 + 0.5));
  return vec3(texelFetch(uLut, ivec2(q.r, 0), 0).r, texelFetch(uLut, ivec2(q.g, 0), 0).g, texelFetch(uLut, ivec2(q.b, 0), 0).b);
}

void main() {
  vec2 p = vUv * uOut;
  vec2 center = uOut * 0.5;
  vec2 pos = center + (p - center - uPan) / uZoom;
  vec2 uv = (pos - uBox.xy) / uBox.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
    outColor = vec4(uBg, 0.0);
    return;
  }
  vec2 P = uGeoOrigin + uv * uGeoExtent;
  vec2 S = uRot * P + uSrcCenter;
  vec3 src = texture(uSrc, S / uSrcDim).rgb;
  if (uGeoOnly > 0.5 || uOriginal > 0.5 || p.x < uSplitX) {
    outColor = vec4(src, 0.0);
    return;
  }
  vec3 c = lutApply(src);
  if (uHsl > 0.5) c = adjustHsl(c);
  float y = dot(c, LUMA);
  vec3 dv = c - vec3(y);
  float pixSat = min(1.0, length(dv) / 0.42);
  float skin = skinWeight(c);
  float factor = max(0.0, 1.0 + uSatMul * (1.0 - skin * 0.65) + uVib * (1.0 - pixSat) * 0.85 * (1.0 - skin));
  if (uSkyOn > 0.5) {
    float m = texture(uSky, uv).r;
    if (m > 0.01) {
      y = y * (1.0 - 0.14 * m) - 0.04 * m * (y - 0.5);
      factor *= 1.0 + 0.28 * m;
    }
  }
  factor *= uKeep;
  vec3 o = clamp(vec3(y) + dv * factor, 0.0, 1.0);
  outColor = vec4(o, 1.0);
}
`

export const BLUR_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uTex;
uniform vec2 uDir;     // (1,0) oder (0,1)
uniform float uSigma;
out vec4 outColor;
void main() {
  ivec2 size = textureSize(uTex, 0);
  ivec2 base = ivec2(gl_FragCoord.xy);
  int radius = int(min(12.0, ceil(uSigma * 3.0)));
  vec3 sum = vec3(0.0);
  float norm = 0.0;
  float k = 1.0 / (2.0 * uSigma * uSigma);
  for (int i = -12; i <= 12; i++) {
    if (i < -radius || i > radius) continue;
    float w = exp(-float(i * i) * k);
    ivec2 at = clamp(base + ivec2(uDir) * i, ivec2(0), size - 1);
    sum += texelFetch(uTex, at, 0).rgb * w;
    norm += w;
  }
  outColor = vec4(sum / norm, 1.0);
}
`

export const DETAIL_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uColor;   // Farbergebnis (Alpha 1 = Details anwenden)
uniform sampler2D uBlur;
uniform float uClarity;
uniform float uSharpen;
uniform float uNoise;
out vec4 outColor;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(uColor, at, 0);
  if (a.a < 0.5) { outColor = vec4(a.rgb, 1.0); return; }
  vec3 c = a.rgb;
  float y = dot(c, LUMA);
  float yb = dot(texelFetch(uBlur, at, 0).rgb, LUMA);
  float detail = y - yb;
  float edge = min(1.0, abs(detail) / 0.07);
  float midtone = 1.0 - min(1.0, abs(y - 0.45) * 1.5);
  float delta = detail * (uClarity * 0.8 * (0.4 + 0.6 * midtone) + uSharpen * 0.95 * edge) - detail * uNoise * 0.85 * (1.0 - edge);
  float scale = y > 0.002 ? clamp(y + delta, 0.0, 1.0) / y : 1.0;
  outColor = vec4(clamp(c * scale, 0.0, 1.0), 1.0);
}
`

/** Ausgabe auf die Zeichenfläche: Alpha verwerfen, Hintergrund bleibt. */
export const COPY_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uTex;
out vec4 outColor;
void main() {
  outColor = vec4(texelFetch(uTex, ivec2(gl_FragCoord.xy), 0).rgb, 1.0);
}
`
