"""分批部署用：印出 create_deployment 的 files 阵列。
   python3 mkpayload.py <batch>           → 该批档案内嵌，其余以「上次部署的 SHA」参照
   python3 mkpayload.py --commit <batch>  → 部署成功后把该批档案的 SHA 记进 manifest
manifest = deploy_manifest.json {path: sha}（Vercel 端已存在的内容）"""
import hashlib, json, sys
from pathlib import Path
BATCH = {
  "infra": ["src/lib/i18n.tsx", "src/i18n/index.ts", "src/i18n/core.ts", "src/main.tsx", "src/App.tsx", "src/pages/StockAnomaly.tsx",
            "STUB:src/i18n/purchasing.ts", "STUB:src/i18n/manager.ts", "STUB:src/i18n/finance.ts", "STUB:src/i18n/ecom.ts", "STUB:src/i18n/pages1.ts", "STUB:src/i18n/pages2.ts"],
  "manager": ["src/pages/Manager.tsx", "src/components/SalesCompare.tsx", "src/i18n/manager.ts"],
  "finance": ["src/pages/Receivables.tsx", "src/pages/Payables.tsx", "src/pages/Alerts.tsx", "src/components/Login.tsx", "src/i18n/finance.ts"],
  "ecom": ["src/pages/EcomReport.tsx", "src/components/AdsEditor.tsx", "src/pages/BranchActual.tsx", "src/i18n/ecom.ts"],
  "pages1": ["src/pages/Dashboard.tsx", "src/pages/ProfitLoss.tsx", "src/pages/StockPage.tsx", "src/pages/ItemRanking.tsx", "src/i18n/pages1.ts"],
  "pages2": ["src/pages/OnePager.tsx", "src/pages/SalesLines.tsx", "src/pages/PriceEffect.tsx", "src/pages/SlowMovers.tsx", "src/i18n/pages2.ts"],
  "kl": ["src/lib/supabase.ts", "src/App.tsx", "src/pages/EcomReport.tsx", "src/i18n/core.ts"],
  "purchasing": ["src/pages/Purchasing.tsx", "src/pages/OpenOrders.tsx", "src/pages/SyncLog.tsx", "src/i18n/purchasing.ts"],
}
STUB = "const d: Record<string, string> = {\n};\nexport default d;\n"
M = Path("deploy_manifest.json")
manifest = json.loads(M.read_text()) if M.exists() else {}
sha = lambda b: hashlib.sha1(b).hexdigest()

if sys.argv[1] == "--commit":
    for f in BATCH[sys.argv[2]]:
        stub = f.startswith("STUB:"); f = f.removeprefix("STUB:")
        manifest[f] = sha(STUB.encode() if stub else Path(f).read_bytes())
    M.write_text(json.dumps(manifest, indent=1)); print("manifest updated:", len(manifest)); sys.exit()

batch = BATCH[sys.argv[1]] + [a[1:] for a in sys.argv[2:] if a.startswith("+")]   # +path 额外内嵌
inline = {}
for f in batch:
    stub = f.startswith("STUB:"); f = f.removeprefix("STUB:")
    inline[f] = STUB if stub else Path(f).read_text(encoding="utf-8")
files = [{"file": f, "sha": s} for f, s in manifest.items() if f not in inline]
files += [{"file": f, "data": d, "encoding": "utf-8"} for f, d in inline.items()]
print(json.dumps(files, ensure_ascii=False))
