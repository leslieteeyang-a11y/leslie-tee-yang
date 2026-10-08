// 首页的送货提醒：我是司机还有几站没签收；可编辑的人看今天这间分店还有几站没签收（重复排的同一站只算一次）
import { useEffect, useState } from "react";
import { can, Me } from "../api";
import { dlv } from "../dlv-api";

export function DeliveryHomeCard({ me }: { me: Me }) {
  const [h, setH] = useState<{ my_stops_left: number; stops_open_today: number | null } | null>(null);
  const show = can(me, "delivery", "view");
  useEffect(() => { if (show) dlv.home().then(setH).catch(() => { /* 首页不因这张卡出错 */ }); }, [show]);
  if (!h) return null;
  return (
    <>
      {h.my_stops_left > 0 && (
        <a className="card att-home warn" href="#/delivery/mine">
          <span><b>🚚 我的送货</b><br /><span className="late">{`还有 ${h.my_stops_left} 站要送`}</span></span>
          <span className="go">去签收 →</span>
        </a>
      )}
      {!!h.stops_open_today && (
        <a className="card att-home" href="#/delivery/runs">
          <span><b>🚚 今天的送货</b><br /><span className="muted">{`今天还有 ${h.stops_open_today} 站没签收`}</span></span>
          <span className="go">看进度 →</span>
        </a>
      )}
    </>
  );
}
