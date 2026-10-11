// Keeps the trading session alive while the app is open: screen wake lock while
// visible, plus a silent audio stream and a held Web Lock so the browser doesn't
// freeze or heavily throttle the tab when minimised / home button pressed.
let wakeLock: any = null;
let audioCtx: AudioContext | null = null;
let releaseLock: (() => void) | null = null;
let active = false;
let visHandler: (() => void) | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;

async function requestWakeLock() {
  try {
    const nav: any = navigator;
    if (!nav.wakeLock || document.visibilityState !== "visible") return;
    if (wakeLock && !wakeLock.released) return;
    wakeLock = await nav.wakeLock.request("screen");
  } catch {
    /* unsupported or denied */
  }
}

function startSilentAudio() {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    audioCtx ??= new Ctx();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0.0001; // inaudible but counts as active playback
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    void audioCtx.resume();
  } catch {
    /* ignore */
  }
}

function holdWebLock() {
  const locks: any = (navigator as any).locks;
  if (!locks?.request) return;
  locks
    .request("megatron-session", () => new Promise<void>((res) => (releaseLock = res)))
    .catch(() => {});
}

/** Call from a user action (Launch button) so audio is allowed to start. */
export function startKeepAlive(onWake?: () => void) {
  if (typeof window === "undefined" || active) return;
  active = true;
  void requestWakeLock();
  startSilentAudio();
  holdWebLock();
  visHandler = () => {
    if (!active) return;
    if (document.visibilityState === "visible") {
      void requestWakeLock();
      void audioCtx?.resume();
      onWake?.();
    }
  };
  document.addEventListener("visibilitychange", visHandler);
  // keep audio context running if the OS suspends it
  heartbeat = setInterval(() => {
    if (audioCtx?.state === "suspended") void audioCtx.resume();
  }, 10_000);
}

export function stopKeepAlive() {
  if (!active) return;
  active = false;
  if (visHandler) document.removeEventListener("visibilitychange", visHandler);
  visHandler = null;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  try {
    wakeLock?.release?.();
  } catch {}
  wakeLock = null;
  void audioCtx?.close().catch(() => {});
  audioCtx = null;
  releaseLock?.();
  releaseLock = null;
}
