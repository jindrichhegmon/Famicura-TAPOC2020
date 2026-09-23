/**
 * Content-Security-Policy stránky: co smí prohlížeč z aplikace kontaktovat.
 *
 * Analýza je knihovna MediaPipe od Googlu. Kromě modelu a WASM se pokouší
 * posílat i telemetrii na odml.pa.googleapis.com. Tady jde jen o kamery
 * v péči o lidi, takže prohlížeč smí mluvit jen s aplikací, s jsdelivr
 * (knihovna a WASM) a s úložištěm modelu. Všechno ostatní odmítne sám.
 *
 * WebRTC (obraz z go2rtc) se CSP netýká.
 */
export const CSP = [
  "default-src 'self'",
  // stránka má vlastní inline <script type=module>; MediaPipe je WASM
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "connect-src 'self' https://cdn.jsdelivr.net https://storage.googleapis.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
  "font-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export const BEZPECNOSTNI_HLAVICKY = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};
