// 登入了但还不在员工名单：看自己的加入申请状态（审核中 / 被拒绝 / 没有申请）。
import { useEffect, useState } from "react";
import { supabase } from "../supabase";

interface St { status: "pending" | "approved" | "rejected"; name: string; created_at: string; decide_note: string }

export default function JoinStatus({ email }: { email: string }) {
  const [st, setSt] = useState<St | null | undefined>(undefined);
  useEffect(() => {
    supabase.rpc("ops_join_status").then(({ data }) => setSt((data as St | null) ?? null));
  }, []);
  const out = () => supabase.auth.signOut();
  if (st === undefined) return <div className="center">载入中…</div>;
  return (
    <div className="center card narrow">
      {st?.status === "pending" ? (
        <>
          <h2>申请审核中</h2>
          <p>{`${st.name}，你的加入申请已经送出，等管理员批准后就能用了。批准后重新整理这一页即可。`}</p>
          <button onClick={() => window.location.reload()}>重新整理</button>{" "}
        </>
      ) : st?.status === "rejected" ? (
        <>
          <h2>申请没有通过</h2>
          {st.decide_note && <p>{`管理员留言：${st.decide_note}`}</p>}
          <p>有问题请直接找管理员。</p>
        </>
      ) : (
        <>
          <h2>还不能进入营运系统</h2>
          <p>{`你的账号（${email}）还没加入员工名单，或已停用。请找管理员在「员工与权限」把你加进去。`}</p>
        </>
      )}
      <button className="ghost" onClick={out}>登出</button>
    </div>
  );
}
