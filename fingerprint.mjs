/**
 * fingerprint.mjs — Browser fingerprint rotation
 * Generates random but consistent fingerprint sets per session
 * Injects via addInitScript to spoof Canvas, WebGL, AudioContext, fonts, etc.
 */

// ─── Random generators ──────────────────────────────────────────────────────

const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const GPU_RENDERERS = [
  'ANGLE (NVIDIA GeForce GTX 1080 Ti Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (Apple M2 Pro)',
  'ANGLE (AMD Radeon Pro 5500M OpenGL Engine)',
  'Mali-G78 MC20',
  'Adreno (TM) 730',
];

const GPU_VENDORS = [
  'Google Inc. (NVIDIA)',
  'Google Inc. (AMD)',
  'Google Inc. (Intel)',
  'Google Inc. (Apple)',
  'ARM',
  'Qualcomm',
];

const PLATFORM_COMBOS = [
  { platform: 'Win32', oscpu: 'Windows NT 10.0; Win64; x64' },
  { platform: 'MacIntel', oscpu: 'Intel Mac OS X 10_15_7' },
  { platform: 'MacIntel', oscpu: 'Apple M2' },
  { platform: 'Linux x86_64', oscpu: 'Linux x86_64' },
];

const FONT_SETS = [
  ['Arial', 'Verdana', 'Times New Roman', 'Georgia', 'Courier New', 'Trebuchet MS', 'Impact'],
  ['Arial', 'Helvetica', 'Times New Roman', 'Courier', 'Verdana', 'Georgia', 'Palatino'],
  ['Segoe UI', 'Arial', 'Verdana', 'Tahoma', 'Times New Roman', 'Courier New', 'Lucida Console'],
  ['San Francisco', 'Helvetica Neue', 'Arial', 'Times', 'Courier', 'Georgia', 'Menlo'],
  ['Roboto', 'Arial', 'Noto Sans', 'DejaVu Sans', 'Liberation Serif', 'Courier New', 'Ubuntu'],
];

const LANGS = [
  ['en-US', 'en'],
  ['en-GB', 'en'],
  ['en-US', 'en', 'fr'],
  ['en-US', 'en', 'de'],
  ['en-US', 'en', 'es'],
];

// ─── Generate fingerprint ────────────────────────────────────────────────────

export function generateFingerprint() {
  const platformCombo = pick(PLATFORM_COMBOS);
  const canvasNoise = rand(1, 255);  // unique noise seed for canvas
  const audioNoise = (Math.random() * 0.0001).toFixed(8);
  const webglRenderer = pick(GPU_RENDERERS);
  const webglVendor = pick(GPU_VENDORS);
  const fonts = pick(FONT_SETS);
  const langs = pick(LANGS);
  const hardwareConcurrency = pick([2, 4, 6, 8, 12, 16]);
  const deviceMemory = pick([2, 4, 8, 16]);
  const maxTouchPoints = pick([0, 0, 0, 1, 5, 10]); // most desktops = 0

  return {
    platform: platformCombo.platform,
    oscpu: platformCombo.oscpu,
    canvasNoise,
    audioNoise: parseFloat(audioNoise),
    webglRenderer,
    webglVendor,
    fonts,
    langs,
    hardwareConcurrency,
    deviceMemory,
    maxTouchPoints,
  };
}

// ─── Inject fingerprint into browser context ──────────────────────────────────

export function getFingerprintScript(fp) {
  return `
    // ─── Canvas fingerprint noise ─────────────────────────────────
    const _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const imageData = ctx.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < imageData.data.length; i += 4) {
          imageData.data[i] = (imageData.data[i] + ${fp.canvasNoise}) % 256;
        }
        ctx.putImageData(imageData, 0, 0);
      }
      return _origToDataURL.apply(this, arguments);
    };

    const _origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function(cb, type, quality) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const imageData = ctx.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < imageData.data.length; i += 4) {
          imageData.data[i] = (imageData.data[i] + ${fp.canvasNoise}) % 256;
        }
        ctx.putImageData(imageData, 0, 0);
      }
      return _origToBlob.apply(this, arguments);
    };

    // ─── WebGL fingerprint ────────────────────────────────────────
    const _getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return '${fp.webglVendor}';        // UNMASKED_VENDOR
      if (param === 37446) return '${fp.webglRenderer}';      // UNMASKED_RENDERER
      return _getParameter.apply(this, arguments);
    };
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const _getParam2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return '${fp.webglVendor}';
        if (param === 37446) return '${fp.webglRenderer}';
        return _getParam2.apply(this, arguments);
      };
    }

    // ─── AudioContext fingerprint ─────────────────────────────────
    const _createOscillator = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function() {
      const osc = _createOscillator.apply(this, arguments);
      const _connect = osc.connect.bind(osc);
      osc.connect = function(dest) {
        if (dest instanceof AnalyserNode) {
          const gain = this.context.createGain();
          gain.gain.value = 1 + ${fp.audioNoise};
          _connect(gain);
          gain.connect(dest);
          return dest;
        }
        return _connect(dest);
      };
      return osc;
    };

    // ─── Platform/hardware ────────────────────────────────────────
    Object.defineProperty(navigator, 'platform', { get: () => '${fp.platform}' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${fp.hardwareConcurrency} });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => ${fp.deviceMemory} });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => ${fp.maxTouchPoints} });
    Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify(fp.langs)} });

    // ─── webdriver = undefined (already done but reinforce) ───────
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    delete window.__playwright;
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
  `;
}

export default { generateFingerprint, getFingerprintScript };
