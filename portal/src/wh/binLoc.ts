// 货架各画面共用：记住上次选的仓位（每间公司各记一个；无痕模式读不到就不记）
export function rememberLoc(company: string, loc?: string): string {
  const key = `hw-bin-loc:${company}`;
  try {
    if (loc !== undefined) localStorage.setItem(key, loc);
    return localStorage.getItem(key) || "";
  } catch { return loc || ""; }
}

// 货架清单展开了哪些区（每间公司各记一份，键 = 仓位|区；无痕模式读不到就每次都收起）
export function rememberOpenZones(company: string, keys?: string[]): string[] {
  const key = `hw-bin-open:${company}`;
  try {
    if (keys !== undefined) localStorage.setItem(key, JSON.stringify(keys));
    const v = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch { return keys ?? []; }
}
