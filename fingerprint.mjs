/**
 * fingerprint.mjs — Browser fingerprint rotation & persistence
 * 
 * Two modes:
 *   - Anonymous (seed=null): random fingerprint every launch — for search, anonymous fetch
 *   - Profile (seed="x-com"): deterministic fingerprint from seed — for auth sessions
 *
 * Profile mode ensures the same profile always presents the same browser identity,
 * so sites don't see "same cookies, different browser" = suspicious.
 */

// ─── Seeded PRNG (Mulberry32) ─────────────────────────────────────────────────

function seedHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createRng(seed) {
  if (seed === null || seed === undefined) {
    // True random
    return {
      rand: (a, b) => Math.floor(Math.random() * (b - a + 1)) + a,
      pick: (arr) => arr[Math.floor(Math.random() * arr.length)],
      float: () => Math.random(),
    };
  }
  const rng = mulberry32(seedHash(String(seed)));
  return {
    rand: (a, b) => Math.floor(rng() * (b - a + 1)) + a,
    pick: (arr) => arr[Math.floor(rng() * arr.length)],
    float: () => rng(),
  };
}

// ─── Fingerprint data pools ──────────────────────────────────────────────────

const GPU_RENDERERS = [
  'ANGLE (NVIDIA GeForce GTX 1080 Ti Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (Apple M2 Pro)',
  'ANGLE (AMD Radeon Pro 5500M OpenGL Engine)',
];

const GPU_VENDORS = [
  'Google Inc. (NVIDIA)',
  'Google Inc. (AMD)',
  'Google Inc. (Intel)',
  'Google Inc. (Apple)',
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

const TIMEZONES = ['America/New_York', 'America/Los_Angeles', 'America/Chicago', 'Europe/London', 'Europe/Berlin'];

// ─── Generate fingerprint ────────────────────────────────────────────────────

/**
 * @param {string|null} seed - Profile name for persistent fingerprint, null for random
 */
export function generateFingerprint(seed = null) {
  const rng = createRng(seed);
  const platformCombo = rng.pick(PLATFORM_COMBOS);

  // Canvas noise: subtle XOR (1-3 bits) instead of large addition
  const canvasNoiseBits = rng.rand(1, 3);

  return {
    _seed: seed,
    _timezone: rng.pick(TIMEZONES),
    platform: platformCombo.platform,
    oscpu: platformCombo.oscpu,
    canvasNoiseBits,
    audioNoise: parseFloat((rng.float() * 0.0001).toFixed(8)),
    webglRenderer: rng.pick(GPU_RENDERERS),
    webglVendor: rng.pick(GPU_VENDORS),
    fonts: rng.pick(FONT_SETS),
    langs: rng.pick(LANGS),
    hardwareConcurrency: rng.pick([2, 4, 6, 8, 12, 16]),
    deviceMemory: rng.pick([2, 4, 8, 16]),
    maxTouchPoints: rng.pick([0, 0, 0, 1, 5, 10]),
  };
}

// ─── Inject fingerprint into browser context ──────────────────────────────────

export function getFingerprintScript(fp) {
  return `
    // ─── Canvas fingerprint noise (subtle XOR, not visible) ───────
    const _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
      const ctx = this.getContext('2d');
      if (ctx && this.width > 0 && this.height > 0) {
        try {
          const imageData = ctx.getImageData(0, 0, this.width, this.height);
          for (let i = 0; i < imageData.data.length; i += 4) {
            imageData.data[i] ^= ${fp.canvasNoiseBits};     // R — XOR 1-3 bits max
            imageData.data[i+1] ^= ${fp.canvasNoiseBits};   // G
          }
          ctx.putImageData(imageData, 0, 0);
        } catch(e) {} // CORS canvas will throw
      }
      return _origToDataURL.apply(this, arguments);
    };

    const _origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function(cb, type, quality) {
      const ctx = this.getContext('2d');
      if (ctx && this.width > 0 && this.height > 0) {
        try {
          const imageData = ctx.getImageData(0, 0, this.width, this.height);
          for (let i = 0; i < imageData.data.length; i += 4) {
            imageData.data[i] ^= ${fp.canvasNoiseBits};
            imageData.data[i+1] ^= ${fp.canvasNoiseBits};
          }
          ctx.putImageData(imageData, 0, 0);
        } catch(e) {}
      }
      return _origToBlob.apply(this, arguments);
    };

    // ─── WebGL fingerprint ────────────────────────────────────────
    const _getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return '${fp.webglVendor}';
      if (param === 37446) return '${fp.webglRenderer}';
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

    // ─── Anti-detection basics ────────────────────────────────────
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    delete window.__playwright;
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
  `;
}

export default { generateFingerprint, getFingerprintScript };
