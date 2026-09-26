import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, COMPANY, COMPANIES, switchCompany, resetCompanyIfNotAllowed } from './lib/supabase';
import Login from './components/Login';
import Dashboard from './pages/Dashboard';
import ProfitLoss from './pages/ProfitLoss';
import SalesLines from './pages/SalesLines';
import OpenOrders from './pages/OpenOrders';
import StockPage from './pages/StockPage';
import ItemRanking from './pages/ItemRanking';
import SlowMovers from './pages/SlowMovers';
import Receivables from './pages/Receivables';
import Alerts from './pages/Alerts';
import Purchasing from './pages/Purchasing';
import Manager from './pages/Manager';
import Payables from './pages/Payables';
import PriceEffect from './pages/PriceEffect';
import OnePager from './pages/OnePager';
import EcomReport from './pages/EcomReport';
import SyncLog from './pages/SyncLog';

const TABS = [
  { key: 'report', label: '月报' },
  { key: 'ecom', label: '电商月报' },
  { key: 'dash', label: '总览' },
  { key: 'alerts', label: '今日异常' },
  { key: 'mgr', label: '门店' },
  { key: 'buy', label: '订货' },
  { key: 'pl', label: '损益' },
  { key: 'ar', label: '应收账款' },
  { key: 'pay', label: '应付账款' },
  { key: 'price', label: '调价跟踪' },
  { key: 'sales', label: '销售明细' },
  { key: 'rank', label: '商品排行' },
  { key: 'stock', label: '库存' },
  { key: 'slow', label: '滞销品' },
  { key: 'oo', label: '未交订单' },
  { key: 'log', label: '同步状态' },
] as const;
type TabKey = (typeof TABS)[number]['key'];
type Role = 'owner' | 'buyer' | 'viewer' | 'manager' | 'sales';
// 订货员只看采购相关页面;店长除损益外全开放,但毛利/成本列一律隐藏(数据层裁列)
const BUYER_TABS: TabKey[] = ['buy', 'pay', 'stock', 'slow', 'oo', 'log'];
const MANAGER_TABS: TabKey[] = ['mgr', 'dash', 'alerts', 'buy', 'ar', 'pay', 'sales', 'rank', 'stock', 'slow', 'oo', 'log'];
// 销售员:只看销售相关页面,毛利/成本一律隐藏(数据层同店长裁列)
const SALES_TABS: TabKey[] = ['dash', 'sales', 'rank', 'stock', 'slow', 'oo'];
// 月报/调价跟踪仅老板可见(月报含利润与现金)
const OWNER_ONLY: TabKey[] = ['report', 'ecom', 'price'];

function ChangePassword({ onDone }: { onDone: () => void }) {
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw1.length < 8) { setMsg('密码至少 8 位'); return; }
    if (pw1 !== pw2) { setMsg('两次输入不一致'); return; }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw1 });
    setBusy(false);
    if (error) { setMsg('修改失败: ' + error.message); return; }
    onDone();
    window.alert('密码已修改');
  }

  return (
    <form className="card card-block" onSubmit={submit}
          style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <strong style={{ fontSize: 13 }}>修改密码</strong>
      <input className="pwfield" type="password" placeholder="新密码(至少 8 位)" value={pw1}
             onChange={(e) => setPw1(e.target.value)} autoComplete="new-password"
             style={{ background: 'var(--page)', color: 'var(--ink)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 10px' }} />
      <input type="password" placeholder="再输入一次" value={pw2}
             onChange={(e) => setPw2(e.target.value)} autoComplete="new-password"
             style={{ background: 'var(--page)', color: 'var(--ink)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 10px' }} />
      <button className="btn primary" disabled={busy}>{busy ? '提交中…' : '确认修改'}</button>
      <button className="btn" type="button" onClick={onDone}>取消</button>
      {msg && <span className="err" style={{ marginTop: 0 }}>{msg}</span>}
    </form>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<TabKey>('dash');
  const [empty, setEmpty] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [role, setRole] = useState<Role | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setRole(null); return; }
    supabase.rpc('bi_me').then(({ data }) => {
      const me = (data as { role?: string; company?: string | null }[] | null)?.[0];
      const r = (me?.role ?? 'viewer') as Role;
      setRole(r);
      resetCompanyIfNotAllowed(r === 'owner', me?.company ?? null);
      if (r === 'buyer') setTab('buy');
      if (r === 'manager') setTab('mgr');
    });
  }, [session?.user.id]);

  if (!ready) return <div className="loading">载入中…</div>;
  if (!session) return <Login />;
  if (role === null) return <div className="loading">载入中…</div>;

  const isHQ = COMPANY === 'HOMEWORKSSB';
  const tabs = role === 'buyer' ? TABS.filter((t) => BUYER_TABS.includes(t.key))
    : role === 'manager' ? TABS.filter((t) => MANAGER_TABS.includes(t.key))
    : role === 'sales' ? TABS.filter((t) => SALES_TABS.includes(t.key))
    : role === 'owner' ? TABS.filter((t) => isHQ || (t.key !== 'report' && t.key !== 'ecom')) // 月报/电商月报目前只算总部
    : TABS.filter((t) => !OWNER_ONLY.includes(t.key));
  const canWrite = role === 'owner' || role === 'buyer';
  const showProfit = role !== 'manager' && role !== 'sales';

  return (
    <div className="shell">
      <div className="topbar">
        <h1>Homeworks BI</h1>
        {role === 'owner' && (
          <select value={COMPANY} onChange={(e) => switchCompany(e.target.value)}
                  style={{ background: COMPANY === 'HOMEWORKSSB' ? 'var(--surface)' : '#3d2f14',
                           color: 'var(--ink)', border: '1px solid var(--border)', borderRadius: 8,
                           padding: '6px 10px', fontFamily: 'inherit', fontSize: 13, fontWeight: 600 }}>
            {Object.entries(COMPANIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        )}
        {COMPANY !== 'HOMEWORKSSB' && (
          <span className="badge" style={{ color: '#f59e0b', background: 'rgba(245,158,11,.16)', fontWeight: 600 }}>
            {role === 'owner' ? `正在看:${COMPANIES[COMPANY]}` : COMPANIES[COMPANY]}
          </span>
        )}
        <nav className="tabs">
          {tabs.map((t) => (
            <button key={t.key} className={tab === t.key ? 'active' : ''}
                    onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </nav>
        <div className="spacer" />
        <span className="who">{session.user.email}</span>
        <button className="btn" onClick={() => setShowPw(!showPw)}>修改密码</button>
        <button className="btn" onClick={() => supabase.auth.signOut()}>退出</button>
      </div>

      {showPw && <ChangePassword onDone={() => setShowPw(false)} />}

      {empty && (
        <div className="notice">
          当前账号看不到任何数据:要么该邮箱未加入白名单(bi.allowed_users),要么同步尚未运行。
          请联系管理员。
        </div>
      )}

      {tab === 'alerts' && <Alerts goTo={(t) => setTab(t as TabKey)} />}
      {tab === 'buy' && <Purchasing canWrite={canWrite} />}
      {tab === 'mgr' && <Manager />}
      {tab === 'dash' && <Dashboard onEmpty={setEmpty} showProfit={showProfit} />}
      {tab === 'pl' && <ProfitLoss />}
      {tab === 'report' && <OnePager />}
      {tab === 'ecom' && <EcomReport />}
      {tab === 'pay' && <Payables showCashflow={role === 'owner' && isHQ} />}
      {tab === 'price' && <PriceEffect />}
      {tab === 'ar' && <Receivables />}
      {tab === 'sales' && <SalesLines showProfit={showProfit} />}
      {tab === 'rank' && <ItemRanking showProfit={showProfit} />}
      {tab === 'stock' && <StockPage showCost={showProfit} />}
      {tab === 'slow' && <SlowMovers showCost={showProfit} />}
      {tab === 'oo' && <OpenOrders />}
      {tab === 'log' && <SyncLog />}
    </div>
  );
}
