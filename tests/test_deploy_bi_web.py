"""deploy_bi_web 的测试（不连 Vercel：纯函数 + 假的 Vercel 物件跑完整流程）。"""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import deploy_bi_web as d  # noqa: E402

# 2026-09-28 线上正式版 dpl_2HzZjNwpUdrSg8iQTKsNQzXU9phT 的档案清单（list_deployment_files 实际回传的 SHA1）
LIVE = {
    "index.html": "14c5ed2ba590151838e4d7b63b17756a6ec56d8f",
    "package-lock.json": "25d922800a7da5bb5ac10e6898047de85fb97d40",
    "package.json": "8bc640f8a020816a2e22dc1d14b9be0f15aab55f",
    "public/apple-touch-icon.png": "e38465ae462c2a6f438f658fec73ce374b787406",
    "public/favicon-48.png": "89fa1beed9b2e4d55732e2545ad3c5ffc5b11b78",
    "public/icon-192.png": "2a79e48d00a1d1b0ed37064dc16c54baf8ef7068",
    "public/icon-512.png": "1e664e69386f0e2d2498259ce330a28dcf1b9676",
    "public/manifest.webmanifest": "6ee33a1a49b3e418cf6ec61235183f9d6d4e7b69",
    "src/App.tsx": "732e8816300b6af3e6bfc3434b02b19bb0976315",
    "src/components/AdsEditor.tsx": "31fd0c1353ff92009424add432dcc56648419adf",
    "src/components/ChartCard.tsx": "d207aca20edbc2ec25b264681db97c10c243c346",
    "src/components/Login.tsx": "692b19745d077f644fd457f14fc33f2056367c8d",
    "src/components/SalesCompare.tsx": "52ea9d2d83a1bd8f2371081ee4d1bd5283a935c5",
    "src/i18n/core.ts": "ce42ebad7e8c0c13c7ab45089c12437474fa7d28",
    "src/i18n/ecom.ts": "1e12ad8d7c3912631489cde5ec147ab884a461d7",
    "src/i18n/finance.ts": "fcbe52558c21da8474043b924bbcf801d1659e93",
    "src/i18n/index.ts": "6f28962c7d01c5760239cd3f935d885f70db3ec7",
    "src/i18n/manager.ts": "481180239b2081b9fc494638561a9285dddb73ff",
    "src/i18n/pages1.ts": "6041f381439190d52e2132d0d762a91710c778ad",
    "src/i18n/pages2.ts": "3793b307290b37004ddcb0b092cc5a7c811c758a",
    "src/i18n/purchasing.ts": "dfb21c222e81ae6d6c4aa58714e66799b42a5d86",
    "src/lib/format.ts": "af7abdd9d040ecf9c50dae5169ee09b8471302fc",
    "src/lib/i18n.tsx": "03baeb9dd5ff9f64b53a247dbe7505ede3782882",
    "src/lib/supabase.ts": "edc66f3bf1a7be3b65e1197392f95a5085bacb00",
    "src/main.tsx": "6e1bcd1034b2597e9900dc72e52c0279399978c8",
    "src/pages/Alerts.tsx": "255c021141e9643b16e555c3e86ff8ae4d4bf9cf",
    "src/pages/BranchActual.tsx": "95bffc1151f6881f7b8f2044bd01e52c3cdacc59",
    "src/pages/Dashboard.tsx": "c28a659514a39e7c4f2ed4eb3f534f9a90318b67",
    "src/pages/EcomReport.tsx": "4c250a8eb5f92c268f071a08b0256289af14701c",
    "src/pages/ItemRanking.tsx": "34324d8973926b8afe248a58dc0f0aba218ab82d",
    "src/pages/Manager.tsx": "8f2c78164363c5cfc3a1558bb350d7a574f1a52b",
    "src/pages/OnePager.tsx": "6e4b22b55a5571ff2b5a2d280a82c90fa1eb8cd5",
    "src/pages/OpenOrders.tsx": "9db16568e24ee4aaa384daabb88ce19f1556e6e1",
    "src/pages/Payables.tsx": "f56a059a74eee76ac034662d70d19515e6d6f4cd",
    "src/pages/PriceEffect.tsx": "3e635a1d65aa7179e945d87e8548ceddd7845a9a",
    "src/pages/ProfitLoss.tsx": "3db7146af4653131f3963ceac696e469467172d3",
    "src/pages/Purchasing.tsx": "bf9bf983b79f573643474a83a5aa51771dcf8864",
    "src/pages/Receivables.tsx": "2f73513c5ccfcb0f929d94bff04079bf321b21b0",
    "src/pages/SalesLines.tsx": "8491423dea2ed99a6f9384db457ca69ad0caddc6",
    "src/pages/SlowMovers.tsx": "103f5125d85e7e7402345ebfbb191ba6170f67e4",
    "src/pages/StockAnomaly.tsx": "bd95c6506235f4a4d05f6a3e2ed5cafe38a254a3",
    "src/pages/StockPage.tsx": "cc2e3a4be739114e88c929ac74d2d8eadde12b38",
    "src/pages/SyncLog.tsx": "b3c879a5707b20567780e792c3101572e7763bd8",
    "src/styles.css": "90e574f01ff2bc7fc6a4dc38fa4ffbef527bd5cc",
    "tsconfig.json": "14e9d5e9e0c89c7bfd84bf5068ef8d3b06612bac",
    "vite.config.ts": "0c897d6f972ea1895b2f1af316e9ea51de65cd0e",
}


def as_tree(files: dict[str, str]) -> list:
    """{路径: sha} → Vercel 用 API 部署时的档案树形状（最上层包一个 src 原始码节点）。"""
    root: dict = {}
    for path, sha in files.items():
        node = root
        *dirs, name = path.split("/")
        for part in dirs:
            node = node.setdefault(part, {})
        node[name] = sha

    def build(node: dict) -> list:
        return [{"name": k, "type": "directory", "mode": 16749, "children": build(v)} if isinstance(v, dict)
                else {"name": k, "type": "file", "mode": 33206, "uid": v} for k, v in sorted(node.items())]

    return [{"name": "src", "type": "directory", "mode": 16749, "children": build(root)}]


# ── flatten_tree ─────────────────────────────────────────────────────────────

def test_flatten_strips_vercel_source_wrapper_and_keeps_real_src_folder():
    live = d.flatten_tree(as_tree(LIVE))
    assert live == LIVE                                   # 顶层 src 被剥掉，但专案真的 src/ 资料夹保留
    assert "src/App.tsx" in live and "App.tsx" not in live


def test_flatten_without_wrapper_and_ignores_non_files():
    tree = [{"name": "package.json", "type": "file", "uid": "a"},
            {"name": "src", "type": "directory", "children": [
                {"name": "main.tsx", "type": "file", "uid": "b"},
                {"name": "fn", "type": "lambda"},
                {"name": "link", "type": "symlink"}]}]
    assert d.flatten_tree(tree) == {"package.json": "a", "src/main.tsx": "b"}


# ── read_overlay / plan_files ────────────────────────────────────────────────

def test_repo_overlay_plans_five_new_and_two_replaced_files():
    overlay, replaces = d.read_overlay(d.DEFAULT_OVERLAY)
    assert "overlay.json" not in overlay                   # 说明档本身不上传
    plan = d.plan_files(LIVE, overlay, replaces)
    assert sorted(plan["replaced"]) == ["src/i18n/index.ts", "vite.config.ts"]
    assert sorted(plan["added"]) == ["loyalty.html", "src/i18n/loyalty.ts", "src/loyalty/loyalty.css",
                                     "src/loyalty/main.tsx", "src/pages/Loyalty.tsx"]
    sent = {f["file"]: f for f in plan["files"]}
    assert set(sent) == set(LIVE) | set(overlay)           # 线上每个档都还在，没有漏掉任何一页
    for path, sha in LIVE.items():
        if path not in overlay:
            assert sent[path] == {"file": path, "sha": sha}  # 没改的档原样引用线上那一版
    assert sent["vite.config.ts"]["sha"] == d.sha1(overlay["vite.config.ts"])
    assert set(plan["upload"]) == set(plan["added"]) | set(plan["replaced"])


def test_rerun_after_deploy_is_a_no_op():
    overlay, replaces = d.read_overlay(d.DEFAULT_OVERLAY)
    after = {**LIVE, **{p: d.sha1(b) for p, b in overlay.items()}}
    plan = d.plan_files(after, overlay, replaces)
    assert plan["upload"] == {} and sorted(plan["same"]) == sorted(overlay)


def test_stops_when_someone_changed_a_replaced_file_online():
    overlay, replaces = d.read_overlay(d.DEFAULT_OVERLAY)
    changed = {**LIVE, "vite.config.ts": "f" * 40}
    with pytest.raises(d.DeployError, match="vite.config.ts.*被改过"):
        d.plan_files(changed, overlay, replaces)


def test_stops_when_new_file_would_overwrite_an_undeclared_online_file():
    with pytest.raises(d.DeployError, match="同名但内容不同"):
        d.plan_files({"package.json": "x", "src/App.tsx": "y"}, {"src/App.tsx": b"new"}, {})


def test_stops_when_replaced_file_disappeared_online():
    with pytest.raises(d.DeployError, match="线上已经没有"):
        d.plan_files({"package.json": "x"}, {"vite.config.ts": b"new"}, {"vite.config.ts": "abc"})


def test_manifest_listing_a_file_the_overlay_lacks_is_rejected(tmp_path):
    (tmp_path / "a.txt").write_text("a", encoding="utf-8")
    (tmp_path / "overlay.json").write_text(json.dumps({"replaces": {"b.txt": "x"}}), encoding="utf-8")
    with pytest.raises(d.DeployError, match="b.txt"):
        d.read_overlay(tmp_path)


def test_missing_overlay_folder_says_what_to_do(tmp_path):
    with pytest.raises(d.DeployError, match="update_from_zip"):
        d.read_overlay(tmp_path / "nope")


# ── clean_token ──────────────────────────────────────────────────────────────

def test_clean_token_strips_whitespace_and_double_paste():
    tok = "AbCdEfGhIjKlMnOpQrStUvWx"
    assert d.clean_token(f"  {tok}\r\n") == tok
    assert d.clean_token(tok + tok) == tok
    assert d.clean_token("short") == "short"


# ── 完整流程（假的 Vercel） ──────────────────────────────────────────────────

class FakeVercel:
    """记录呼叫；线上是 LIVE，建出来的新部署档案树 = 送出去的清单。"""

    def __init__(self, token, team_id, final_state="READY"):
        self.uploaded, self.created, self.final_state = [], None, final_state
        self.prod = "dpl_old"

    def production_deployment(self, project, domain):
        return self.prod

    def live_files(self, deployment_id):
        if deployment_id == "dpl_old":
            return dict(LIVE)
        return {f["file"]: f["sha"] for f in self.created}

    def upload(self, data):
        self.uploaded.append(d.sha1(data))

    def create(self, project, files):
        self.created = files
        return {"id": "dpl_new"}

    def wait(self, deployment_id, limit_s=900):
        if self.final_state == "READY":
            self.prod = deployment_id
        return {"readyState": self.final_state, "errorMessage": "Build failed" if self.final_state != "READY" else None}

    def build_log_tail(self, deployment_id, n=25):
        return ["error TS2307: Cannot find module"]


def run(monkeypatch, check_only=False, final_state="READY"):
    fake = FakeVercel("t", "team", final_state)
    monkeypatch.setattr(d, "Vercel", lambda token, team_id: fake)
    monkeypatch.setattr(d.time, "sleep", lambda s: None)
    d.deploy(d.DEFAULT_OVERLAY, check_only, {**d.DEFAULTS, "token": "t"})
    return fake


def test_deploy_uploads_only_changed_files_and_prints_new_page(monkeypatch, capsys):
    fake = run(monkeypatch)
    overlay, _ = d.read_overlay(d.DEFAULT_OVERLAY)
    assert sorted(fake.uploaded) == sorted(d.sha1(b) for b in overlay.values())
    assert len(fake.created) == len(set(LIVE) | set(overlay))
    out = capsys.readouterr().out
    assert "https://homeworks-bi.vercel.app/loyalty.html" in out and "完成" in out


def test_check_only_never_uploads_or_deploys(monkeypatch, capsys):
    fake = run(monkeypatch, check_only=True)
    assert fake.uploaded == [] and fake.created is None
    assert "只检查" in capsys.readouterr().out


def test_failed_build_reports_log_and_says_site_unchanged(monkeypatch):
    with pytest.raises(d.DeployError) as e:
        run(monkeypatch, final_state="ERROR")
    msg = str(e.value)
    assert "没有被换掉" in msg and "TS2307" in msg and "Build failed" in msg


# ── 审查后补的：金钥失效、网路断线、部署建立后才出错 ─────────────────────────

def test_network_drop_mid_response_becomes_a_chinese_message(monkeypatch):
    """真的开一个「接上就断线」的服务器：urllib 这种错不会包成 URLError，以前会印英文 traceback。"""
    import socket
    import threading

    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)

    def accept_and_drop():
        conn, _ = srv.accept()
        conn.recv(65536)
        conn.close()

    threading.Thread(target=accept_and_drop, daemon=True).start()
    monkeypatch.setattr(d, "API", f"http://127.0.0.1:{srv.getsockname()[1]}")
    with pytest.raises(d.DeployError) as e:
        d.Vercel("t", "team").call("GET", "/v9/projects/x", timeout=5)
    srv.close()
    assert e.value.transient and "连线中断" in str(e.value)


def test_get_retries_transient_errors_but_not_bad_key(monkeypatch):
    monkeypatch.setattr(d.time, "sleep", lambda s: None)
    vc = d.Vercel("t", "team")
    calls = []

    def flaky(method, path, query=None):
        calls.append(path)
        if len(calls) < 3:
            raise d.DeployError("断线", transient=True)
        return {"ok": True}

    monkeypatch.setattr(vc, "call", flaky)
    assert vc.get("/x") == {"ok": True} and len(calls) == 3

    def bad_key(method, path, query=None):
        calls.append(path)
        raise d.DeployError("401", status=401)

    calls.clear()
    monkeypatch.setattr(vc, "call", bad_key)
    with pytest.raises(d.DeployError):
        vc.get("/x")
    assert len(calls) == 1                                  # 金钥错不重试


class KeyCheck:
    def __init__(self, status):
        self.status = status

    def __call__(self, token, team_id):
        outer = self

        class _V:
            def get(self, path, query=None, tries=4):
                if outer.status:
                    raise d.DeployError(f"Vercel 回应 {outer.status}", status=outer.status)
                return {"id": "prj"}
        return _V()


def test_expired_saved_key_asks_for_a_new_one_in_the_same_double_click(monkeypatch):
    asked = []
    monkeypatch.setattr(d, "Vercel", KeyCheck(401))
    monkeypatch.setattr(d, "ask_token", lambda s: asked.append(s) or {**s, "token": "new"})
    out = d.ensure_token({**d.DEFAULTS, "token": "old"})
    assert out["token"] == "new" and "token" not in asked[0]


def test_good_saved_key_is_used_without_asking(monkeypatch):
    monkeypatch.setattr(d, "Vercel", KeyCheck(None))
    monkeypatch.setattr(d, "ask_token", lambda s: pytest.fail("不该问金钥"))
    assert d.ensure_token({**d.DEFAULTS, "token": "ok"})["token"] == "ok"


def test_server_error_on_key_check_is_not_mistaken_for_a_bad_key(monkeypatch):
    monkeypatch.setattr(d, "Vercel", KeyCheck(500))
    monkeypatch.setattr(d, "ask_token", lambda s: pytest.fail("不该问金钥"))
    with pytest.raises(d.DeployError):
        d.ensure_token({**d.DEFAULTS, "token": "ok"})


def test_rejected_new_key_is_not_saved(monkeypatch, tmp_path):
    key_file = tmp_path / "vercel_token.json"
    monkeypatch.setattr(d, "KEY_PATH", key_file)
    monkeypatch.setattr(d, "_read_secret", lambda prompt: "X" * 24)
    monkeypatch.setattr(d, "Vercel", KeyCheck(403))
    with pytest.raises(d.DeployError, match="什么都没存"):
        d.ask_token(dict(d.DEFAULTS))
    assert not key_file.exists()


def test_accepted_new_key_is_saved(monkeypatch, tmp_path):
    key_file = tmp_path / "vercel_token.json"
    monkeypatch.setattr(d, "KEY_PATH", key_file)
    monkeypatch.setattr(d, "_read_secret", lambda prompt: "Y" * 24)
    monkeypatch.setattr(d, "Vercel", KeyCheck(None))
    d.ask_token(dict(d.DEFAULTS))
    assert json.loads(key_file.read_text(encoding="utf-8"))["token"] == "Y" * 24


class DropsWhileWaiting(FakeVercel):
    def wait(self, deployment_id, limit_s=900):
        raise d.DeployError("跟 Vercel 的连线中断（ConnectionResetError）。", transient=True)


def test_error_after_deployment_was_created_says_do_not_redeploy(monkeypatch):
    fake = DropsWhileWaiting("t", "team")
    monkeypatch.setattr(d, "Vercel", lambda token, team_id: fake)
    with pytest.raises(d.DeployError) as e:
        d.deploy(d.DEFAULT_OVERLAY, False, {**d.DEFAULTS, "token": "t"})
    msg = str(e.value)
    assert "dpl_new 已经建立" in msg and "先不要重新部署" in msg


def test_build_failure_is_not_told_that_it_will_go_live(monkeypatch):
    with pytest.raises(d.BuildFailed) as e:
        run(monkeypatch, final_state="ERROR")
    assert "先不要重新部署" not in str(e.value)


def test_invalid_token_is_not_blamed_on_scope(monkeypatch):
    import io
    import urllib.error

    def boom(req, timeout=0):
        raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {}, io.BytesIO(
            b'{"error":{"code":"forbidden","message":"Not authorized","invalidToken":true}}'))

    monkeypatch.setattr(d.urllib.request, "urlopen", boom)
    with pytest.raises(d.DeployError) as e:
        d.Vercel("t", "team").call("GET", "/v9/projects/x")
    assert "不认得这串金钥" in str(e.value) and "Scope" not in str(e.value).split("\n")[0]
