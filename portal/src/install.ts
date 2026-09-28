// 「加到手机主画面」：Android Chrome 会发 beforeinstallprompt（只发一次，要在最早就接住）；
// iPhone Safari 没有这个事件，只能教员工按「分享 → 加入主画面」。
export interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferred = e as InstallPromptEvent;
  listeners.forEach((f) => f());
});
window.addEventListener("appinstalled", () => {
  deferred = null;
  listeners.forEach((f) => f());
});

export function canPromptInstall(): boolean {
  return deferred !== null;
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  listeners.forEach((f) => f());
  return outcome === "accepted";
}

export function onInstallChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** 已经从主画面打开（独立视窗）就不用再提示 */
export function isStandalone(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

// localStorage 在无痕模式可能丢错，一律包起来
export function hintDismissed(): boolean {
  try { return localStorage.getItem("hw-install-hint") === "no"; } catch { return false; }
}
export function dismissHint(): void {
  try { localStorage.setItem("hw-install-hint", "no"); } catch { /* 忽略 */ }
}
