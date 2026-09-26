// 极简 hash 路由：#/tasks、#/m/warehouse …（静态网站不用另设改写规则）
import { useEffect, useState } from "react";

export function currentRoute(): string {
  return window.location.hash.replace(/^#/, "") || "/";
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
