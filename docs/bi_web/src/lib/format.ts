export function fmtRM(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return (
    'RM ' +
    v.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

export function fmtNum(n: number | string | null | undefined, digits = 0): string {
  return Number(n ?? 0).toLocaleString('en-MY', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 图表纵轴刻度:1.2M / 350k */
export function fmtCompact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(0) + 'k';
  return String(v);
}

export function ymLabel(yr: number, mth: number): string {
  return `${yr}-${String(mth).padStart(2, '0')}`;
}

export function fmtDate(d: string | null | undefined): string {
  return d ? d.slice(0, 10) : '';
}
