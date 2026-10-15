import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { supabase } from '../lib/supabase';
import './join.css';

// 顾客自己扫 QR 登记(/join.html?s=HQ 或 ?s=JB):不用登入,只呼叫 RPC public.bi_customer_signup(anon 可用)。
// 2026-10-06 使用者改成不用店员确认:送出就直接写进顾客资料(每笔改动留在修改纪录)。
// 这页不回传任何顾客资讯;三种语言写在这里,不进主看板的字典。
// 2026-10-06 使用者要求「住哪一区」改成送货地址(员工送货用),再加电邮;RPC 用 9 个参数的新版(p_address、p_email)。
// 送出成功后自动带到品牌网站 www.hemos.com.my(几秒后跳转,也可以直接按按钮)。

const SITE = 'https://www.hemos.com.my';
const REDIRECT_SECONDS = 4;

type L = 'zh' | 'en' | 'ms';
const TXT: Record<string, Record<L, string>> = {
  title: { zh: '顾客登记', en: 'Customer sign-up', ms: 'Pendaftaran pelanggan' },
  intro: {
    zh: '留下资料，生日与新品优惠会通知你。只要 30 秒。',
    en: 'Leave your details to hear about birthday and new-product offers. Takes 30 seconds.',
    ms: 'Tinggalkan maklumat anda untuk tawaran hari jadi dan produk baharu. 30 saat sahaja.',
  },
  phone: { zh: '手机号码 *', en: 'Mobile number *', ms: 'Nombor telefon bimbit *' },
  name: { zh: '名字 *', en: 'Name *', ms: 'Nama *' },
  birthday: { zh: '生日（选填）', en: 'Birthday (optional)', ms: 'Hari jadi (pilihan)' },
  month: { zh: '月', en: 'Month', ms: 'Bulan' },
  day: { zh: '日', en: 'Day', ms: 'Hari' },
  address: {
    zh: '送货地址（选填，方便我们送货）', en: 'Delivery address (optional, for our deliveries)',
    ms: 'Alamat penghantaran (pilihan, untuk penghantaran kami)',
  },
  email: { zh: '电邮（选填）', en: 'Email (optional)', ms: 'E-mel (pilihan)' },
  needEmail: { zh: '电邮格式不对，例：ali@gmail.com', en: 'Please check the email, e.g. ali@gmail.com', ms: 'Sila semak e-mel, cth. ali@gmail.com' },
  goSite: { zh: '前往 Hemos 网站', en: 'Visit the Hemos website', ms: 'Lawati laman web Hemos' },
  goingSite: { zh: '{s} 秒后带你到 Hemos 网站…', en: 'Taking you to the Hemos website in {s}s…', ms: 'Ke laman web Hemos dalam {s} saat…' },
  addressHint: { zh: '例：12, Jalan Skudai 3, Taman Universiti, 81300 Skudai', en: 'e.g. 12, Jalan Skudai 3, Taman Universiti, 81300 Skudai', ms: 'cth. 12, Jalan Skudai 3, Taman Universiti, 81300 Skudai' },
  consent: {
    zh: '我同意 HomeWorks 用 WhatsApp 发优惠与新品讯息给我，可随时回复 STOP 取消。',
    en: 'I agree to receive offers and new-product messages from HomeWorks on WhatsApp. Reply STOP anytime to opt out.',
    ms: 'Saya setuju menerima tawaran dan berita produk baharu daripada HomeWorks melalui WhatsApp. Balas STOP untuk berhenti.',
  },
  send: { zh: '送出', en: 'Submit', ms: 'Hantar' },
  sending: { zh: '送出中…', en: 'Sending…', ms: 'Menghantar…' },
  privacy: {
    zh: '资料只用于 HomeWorks 的顾客服务与优惠通知，不会提供给第三方。',
    en: 'Your details are only used by HomeWorks for customer service and offers, and are never shared with third parties.',
    ms: 'Maklumat anda hanya digunakan oleh HomeWorks untuk khidmat pelanggan dan tawaran, dan tidak dikongsi dengan pihak ketiga.',
  },
  done: { zh: '谢谢！已收到', en: 'Thank you! Received', ms: 'Terima kasih! Diterima' },
  doneSub: {
    zh: '登记完成，谢谢支持 HomeWorks！',
    en: 'You are signed up. Thank you for supporting HomeWorks!',
    ms: 'Pendaftaran selesai. Terima kasih kerana menyokong HomeWorks!',
  },
  needPhone: { zh: '请输入完整手机号', en: 'Please enter your full mobile number', ms: 'Sila masukkan nombor telefon penuh' },
  needName: { zh: '请填名字', en: 'Please enter your name', ms: 'Sila masukkan nama' },
  needBoth: { zh: '生日要月、日都选', en: 'Choose both month and day', ms: 'Pilih bulan dan hari' },
  fail: { zh: '送出失败：', en: 'Could not submit: ', ms: 'Gagal dihantar: ' },
};

function initialLang(): L {
  const n = (navigator.language || '').toLowerCase();
  return n.startsWith('zh') ? 'zh' : n.startsWith('ms') || n.startsWith('id') ? 'ms' : 'zh';
}

function Join() {
  const [lang, setLang] = useState<L>(initialLang);
  const t = (k: string) => TXT[k][lang];
  const store = (new URLSearchParams(location.search).get('s') || '').toUpperCase();
  const [f, setF] = useState({ phone: '', name: '', bm: '', bd: '', email: '', address: '', consent: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [left, setLeft] = useState(REDIRECT_SECONDS);

  // 登记成功后倒数,时间到就带到品牌网站
  useEffect(() => {
    if (!done) return;
    if (left <= 0) { location.href = SITE; return; }
    const id = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(id);
  }, [done, left]);

  async function send() {
    if (f.phone.replace(/\D/g, '').length < 8) { setErr(t('needPhone')); return; }
    if (!f.name.trim()) { setErr(t('needName')); return; }
    if (!!f.bm !== !!f.bd) { setErr(t('needBoth')); return; }
    if (f.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) { setErr(t('needEmail')); return; }
    setBusy(true);
    setErr(null);
    const r = await supabase.rpc('bi_customer_signup', {
      p_phone: f.phone, p_name: f.name, p_birth_month: f.bm ? Number(f.bm) : null, p_birth_day: f.bd ? Number(f.bd) : null,
      p_area: null, p_address: f.address, p_email: f.email, p_consent: f.consent, p_store: store === 'HQ' || store === 'JB' ? store : null,
    });
    setBusy(false);
    if (r.error) { setErr(t('fail') + r.error.message); return; }
    setDone(true);
  }

  return (
    <div className="jn">
      <div className="jn-top">
        <h1>HomeWorks</h1>
        <div className="jn-lang">
          {(['zh', 'en', 'ms'] as L[]).map((l) => (
            <button key={l} className={lang === l ? 'on' : ''} onClick={() => setLang(l)}>
              {l === 'zh' ? '中文' : l === 'en' ? 'EN' : 'BM'}
            </button>
          ))}
        </div>
      </div>
      <div className="jn-card">
        {done ? (
          <div className="jn-done">
            <div className="big">✓</div>
            <h2>{t('done')}</h2>
            <p>{t('doneSub')}</p>
            <a className="jn-go jn-link" href={SITE}>{t('goSite')}</a>
            <p className="jn-small">{t('goingSite').replace('{s}', String(left))}</p>
          </div>
        ) : (
          <>
            <h2 style={{ marginTop: 0 }}>{t('title')}</h2>
            <p>{t('intro')}</p>
            <label htmlFor="jn-phone">{t('phone')}</label>
            <input id="jn-phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="012-345 6789"
                   value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
            <label htmlFor="jn-name">{t('name')}</label>
            <input id="jn-name" autoComplete="name" maxLength={60} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <label>{t('birthday')}</label>
            <div className="jn-row">
              <select aria-label={t('month')} value={f.bm} onChange={(e) => setF({ ...f, bm: e.target.value })}>
                <option value="">{t('month')}</option>
                {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
              </select>
              <select aria-label={t('day')} value={f.bd} onChange={(e) => setF({ ...f, bd: e.target.value })}>
                <option value="">{t('day')}</option>
                {Array.from({ length: 31 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
              </select>
            </div>
            <label htmlFor="jn-email">{t('email')}</label>
            <input id="jn-email" type="email" inputMode="email" autoComplete="email" maxLength={120} placeholder="ali@gmail.com"
                   value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            <label htmlFor="jn-address">{t('address')}</label>
            <textarea id="jn-address" rows={3} maxLength={300} autoComplete="street-address" placeholder={t('addressHint')}
                      value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
            <label className="jn-check">
              <input type="checkbox" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} />
              <span>{t('consent')}</span>
            </label>
            <button className="jn-go" disabled={busy} onClick={send}>{busy ? t('sending') : t('send')}</button>
            {err && <div className="jn-err">{err}</div>}
            <div className="jn-small">{t('privacy')}</div>
          </>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Join />
  </React.StrictMode>
);
