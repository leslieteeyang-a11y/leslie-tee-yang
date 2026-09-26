import { LEVEL_LABEL, Module } from "../api";

// 还没做好的模块：说明会有什么、第几阶段，让员工知道路线图
const DETAIL: Record<string, string[]> = {
  purchasing: ["未到货 PO 清单（从 AutoCount 每日同步）", "采购员填写 / 更新预计到货日（ETA）、货柜号、状态",
    "逾期未到自动标红、提醒负责人", "业务可查某个 SKU 什么时候到货"],
  warehouse: ["库存查询（各仓位）", "销售订单预留", "拣货单与出货确认", "收货登记"],
  delivery: ["送货排程（日历）", "司机 / 安装师傅指派", "签收与照片", "安装完成回报"],
  sales: ["客户资料", "销售订单进度", "个人 / 门市业绩"],
  collection: ["应收账款与账龄", "催收提醒", "收款登记"],
  commission: ["佣金计算规则", "每月佣金明细与审批", "佣金报表"],
  hr: ["员工档案", "打卡 / 出勤", "请假申请（接「审批」模块）", "绩效纪录"],
  payroll: ["每月薪资计算", "津贴与扣款", "薪资单"],
  reports: ["电商月报", "管理报表", "问 AI（用自然语言查数据）"],
};

export default function Planned({ module }: { module: Module }) {
  return (
    <div className="card narrow">
      <h2>{module.name} <span className="badge">第 {module.phase} 阶段 · 规划中</span></h2>
      <p className="muted">{module.description}</p>
      {DETAIL[module.key] && (
        <>
          <h3>预计会有</h3>
          <ul>{DETAIL[module.key].map((d) => <li key={d}>{d}</li>)}</ul>
        </>
      )}
      <p className="muted">你在这个模块的权限：{LEVEL_LABEL[module.level]}。有想法或需求，可以先在「任务」开一张给管理层。</p>
    </div>
  );
}
