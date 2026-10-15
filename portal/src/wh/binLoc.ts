// 货架各画面共用：记住上次选的仓位（每间公司各记一个；无痕模式读不到就不记）
export function rememberLoc(company: string, loc?: string): string {
  const key = `hw-bin-loc:${company}`;
  try {
    if (loc !== undefined) localStorage.setItem(key, loc);
    return localStorage.getItem(key) || "";
  } catch { return loc || ""; }
}
