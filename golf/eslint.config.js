export default [
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly', performance: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', localStorage: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        console: 'readonly', MessageChannel: 'readonly', AudioContext: 'readonly', OffscreenCanvas: 'readonly',
        ImageData: 'readonly', getComputedStyle: 'readonly', matchMedia: 'readonly', screen: 'readonly',
        process: 'readonly', URL: 'readonly', Float32Array: 'readonly', Float64Array: 'readonly',
        Int8Array: 'readonly', Uint8ClampedArray: 'readonly', Path2D: 'readonly', globalThis: 'readonly',
        queueMicrotask: 'readonly', structuredClone: 'readonly', HTMLElement: 'readonly', Image: 'readonly',
        Buffer: 'readonly', URLSearchParams: 'readonly', location: 'readonly', ResizeObserver: 'readonly',
        Event: 'readonly', PointerEvent: 'readonly', CustomEvent: 'readonly',
        // WebGL, typed arrays and viewport globals used by the golf renderer and shell.
        WebGLRenderingContext: 'readonly', WebGL2RenderingContext: 'readonly', Uint8Array: 'readonly',
        Uint16Array: 'readonly', Uint32Array: 'readonly', Int16Array: 'readonly', Int32Array: 'readonly',
        ArrayBuffer: 'readonly', DataView: 'readonly', devicePixelRatio: 'readonly',
        visualViewport: 'readonly', innerWidth: 'readonly', innerHeight: 'readonly', Promise: 'readonly',
        HTMLCanvasElement: 'readonly', KeyboardEvent: 'readonly', addEventListener: 'readonly',
        removeEventListener: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none' }],
      'no-undef': 'error',
    },
  },
  { ignores: ['dist/**', 'node_modules/**'] },
];
