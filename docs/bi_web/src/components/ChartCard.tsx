import { ReactNode } from 'react';

export function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card card-block">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}
