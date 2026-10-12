// 极简 hash 路由：#/tasks、#/m/warehouse …（静态网站不用另设改写规则）
import { useEffect, useState } from "react";

export function currentRoute(): string {
  return window.location.hash.replace(/^#/, "") || "/";
}

// 有修改还没储存的画面（例：厂家 DO 编辑）：换页前先问。hash 换了才收到通知（取消不了），
// 所以不肯离开就把网址换回来，并挡住后面的 hashchange 处理（这个监听最早登记，先执行）。
let leaveGuard: (() => boolean) | null = null;
let lastHash = window.location.hash;
window.addEventListener("hashchange", (e) => {
  if (leaveGuard && window.location.hash !== lastHash && !leaveGuard()) {
    e.stopImmediatePropagation();
    window.history.replaceState(null, "", lastHash || "#/");
    return;
  }
  lastHash = window.location.hash;
});

/** guard 回传 false = 留在这页；null = 拿掉 */
export function setLeaveGuard(guard: (() => boolean) | null): void {
  leaveGuard = guard;
}

/** 换网址但不重新载入画面（例：新开的单第一次存，网址换成单号） */
export function replaceRoute(path: string): void {
  window.history.replaceState(null, "", "#" + path);
  lastHash = window.location.hash;
}

export function useRoute(): string {
  const [route, setRoute] = useState(currentRoute());
  useEffect(() => {
    const on = () => setRoute(currentRoute());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function go(path: string) {
  window.location.hash = path;
}
