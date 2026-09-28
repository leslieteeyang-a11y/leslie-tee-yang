#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 BI 网页（Vercel 专案 homeworks-bi）的改版部署上线：线上现有的档全部沿用，只加上 / 换掉改版目录里的档。

    python scripts/deploy_bi_web.py                 # 部署 docs/bi_web/loyalty（顾客积分页）
    python scripts/deploy_bi_web.py --check         # 只检查：金钥、线上版本、会动到哪些档，不部署
    python scripts/deploy_bi_web.py --set-key       # 换一把 Vercel 金钥
    python scripts/deploy_bi_web.py docs/bi_web/xxx # 部署别的改版目录

为什么要这支程式：BI 网页的原始码不在 GitHub，线上那一版是最新的；Claude 的 Vercel 连接器（2026-09-28 起）
不能建部署，而使用者电脑上的原始码可能比线上旧，拿它部署会盖掉之前的修改。所以这里用使用者自己的 Vercel 金钥，
先读线上正式版本的档案清单（每个档的 SHA1），没改的档原样引用，改版目录里的档才上传。

改版目录里的 overlay.json 写明它「要换掉哪些线上档、以及当初是以哪一版（SHA1）为底改的」。线上那个档若已经
不是那一版（有人在这之间改过网页），程式会停下来，不会盖掉别人的修改。其余档案不能跟线上同名但内容不同。
金钥存在 vercel_token.json（不会上传 git，也不会被 update_from_zip 覆盖）。
"""

import argparse
import base64
import hashlib
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "https://api.vercel.com"
KEY_PATH = ROOT / "vercel_token.json"
DEFAULT_OVERLAY = ROOT / "docs" / "bi_web" / "loyalty"
MANIFEST = "overlay.json"
DEFAULTS = {"project": "homeworks-bi", "team_id": "team_IA7hNGv1797N7fYFAD4mJd08",
            "domain": "homeworks-bi.vercel.app"}
TOKEN_HELP = """\
第一次使用要一把 Vercel 金钥（token）：
  1. 用浏览器打开 https://vercel.com/account/tokens （用 leslieteeyang@gmail.com 登入）
  2. 按 Create（建立），名称填 homeworks-deploy；
     有 Scope 就选 leslie tee；有 Expiration（期限）建议选 90 天。
  3. 按 Create 后会出现一串字（只显示这一次），按旁边的复制。
  4. 回到这个视窗贴上（按滑鼠右键一次），再按 Enter。"""


class DeployError(Exception):
    """要告诉使用者、然后停下来的状况（讯息已写成该检查什么）。"""


# ── 纯函数（tests/test_deploy_bi_web.py 测这些） ─────────────────────────────

def sha1(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()


def flatten_tree(tree: list) -> dict[str, str]:
    """Vercel 档案树（/v6/deployments/{id}/files）→ {相对路径: SHA1}。

    用 API 建的部署，档案树最上层会包一个叫 src 的「原始码」节点，不是专案真的 src 资料夹；
    认得出来（只有一个 src 目录、里面有 package.json）就剥掉。只收 type == file。"""
    nodes = tree
    if (len(tree) == 1 and tree[0].get("type") == "directory" and tree[0].get("name") == "src"
            and any(c.get("name") == "package.json" and c.get("type") == "file" for c in tree[0].get("children") or [])):
        nodes = tree[0].get("children") or []
    out: dict[str, str] = {}

    def walk(items: list, prefix: str) -> None:
        for n in items:
            path = f"{prefix}{n.get('name')}"
            if n.get("type") == "directory":
                walk(n.get("children") or [], path + "/")
            elif n.get("type") == "file" and n.get("uid"):
                out[path] = n["uid"]

    walk(nodes, "")
    return out


def read_overlay(folder: Path) -> tuple[dict[str, bytes], dict[str, str]]:
    """改版目录 → ({部署路径: 内容}, {要换掉的路径: 当初为底的 SHA1})。overlay.json 本身不上传。"""
    if not folder.is_dir():
        raise DeployError(f"找不到改版目录 {folder}。请确认程式是最新版（重新下载 ZIP 再双击 update_from_zip.bat）。")
    manifest_path = folder / MANIFEST
    replaces = {}
    if manifest_path.exists():
        replaces = json.loads(manifest_path.read_text(encoding="utf-8")).get("replaces") or {}
    files = {p.relative_to(folder).as_posix(): p.read_bytes()
             for p in sorted(folder.rglob("*")) if p.is_file() and p.name != MANIFEST}
    if not files:
        raise DeployError(f"{folder} 里没有要部署的档。")
    missing = sorted(set(replaces) - set(files))
    if missing:
        raise DeployError(f"{MANIFEST} 说要换掉 {', '.join(missing)}，但改版目录里没有这些档。")
    return files, replaces


def plan_files(live: dict[str, str], overlay: dict[str, bytes], replaces: dict[str, str]) -> dict:
    """算出这次部署要送的档案清单。回传 {files, upload, added, replaced, same}。

    - 线上有、改版没有的档：原样引用（{file, sha}）
    - 改版的新档：上传
    - 改版要换掉的档：线上那个档必须还是当初的底（replaces 里的 SHA1），否则停下来
    - 改版跟线上内容一样：不算变动（重跑不会重复部署）"""
    added, replaced, same, conflicts = [], [], [], []
    upload: dict[str, bytes] = {}
    for path, data in sorted(overlay.items()):
        digest = sha1(data)
        if live.get(path) == digest:
            same.append(path)
        elif path not in live:
            if path in replaces:
                conflicts.append(f"{path}：说要换掉线上的档，但线上已经没有这个档")
            else:
                added.append(path)
                upload[path] = data
        elif path in replaces and live[path] == replaces[path]:
            replaced.append(path)
            upload[path] = data
        elif path in replaces:
            conflicts.append(f"{path}：线上这个档在这之间被改过（线上 {live[path][:10]}…，当初的底 {replaces[path][:10]}…）")
        else:
            conflicts.append(f"{path}：线上已经有同名但内容不同的档，改版没说要换掉它")
    if conflicts:
        raise DeployError("线上网页跟这份改版对不上，为了不盖掉别人的修改，这次不部署：\n  - "
                          + "\n  - ".join(conflicts)
                          + "\n请把这段讯息贴给 Claude，请它以线上最新版重新合并改版。")
    files = [{"file": p, "sha": s} for p, s in sorted(live.items()) if p not in overlay]
    files += [{"file": p, "sha": sha1(d), "size": len(d)} for p, d in sorted(overlay.items())]
    return {"files": files, "upload": upload, "added": added, "replaced": replaced, "same": same}


def clean_token(raw: str) -> str:
    """贴上的金钥去掉空白；右键按了两下会贴成两串一样的，取一半。"""
    tok = "".join(raw.split())
    half = len(tok) // 2
    if len(tok) % 2 == 0 and half >= 20 and tok[:half] == tok[half:]:
        print("（侦测到金钥被重复贴上，已只取一次。）")
        tok = tok[:half]
    return tok


# ── Vercel API ───────────────────────────────────────────────────────────────

class Vercel:
    def __init__(self, token: str, team_id: str):
        self.token, self.team_id = token, team_id

    def call(self, method: str, path: str, body=None, raw: bytes | None = None,
             headers: dict | None = None, query: dict | None = None, timeout: int = 120):
        q = {"teamId": self.team_id, **(query or {})}
        url = f"{API}{path}?{urllib.parse.urlencode(q)}"
        hdrs = {"Authorization": f"Bearer {self.token}", **(headers or {})}
        data = raw
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            hdrs["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                text = r.read().decode("utf-8") or "null"
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:400]
            hint = {401: "金钥不对、过期或被删了。请执行 deploy_bi_web.bat --set-key 换一把新的。",
                    403: "这把金钥没有权限。建金钥时 Scope 要选 leslie tee（不是个人帐号），再用 --set-key 换上。",
                    404: "找不到东西（专案名称或部署编号不对）。",
                    429: "Vercel 暂时限制请求次数，过几分钟再试。"}.get(e.code, "")
            raise DeployError(f"Vercel 回应 {e.code}（{method} {path}）{hint}\n  {detail}")
        except urllib.error.URLError as e:
            raise DeployError(f"连不上 Vercel：{e.reason}\n  请检查这台电脑的网路，能不能用浏览器打开 https://vercel.com。")
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text

    def production_deployment(self, project: str, domain: str) -> str:
        """目前正式网址（domain）指着的部署。先问别名；问不到再看专案的 production target。"""
        try:
            alias = self.call("GET", f"/v4/aliases/{domain}")
            dep = alias.get("deploymentId") or (alias.get("deployment") or {}).get("id")
            if dep:
                return dep
        except DeployError:
            pass
        proj = self.call("GET", f"/v9/projects/{project}")
        dep = ((proj.get("targets") or {}).get("production") or {}).get("id")
        if not dep:
            ready = [d for d in proj.get("latestDeployments") or []
                     if d.get("target") == "production" and d.get("readyState") == "READY"]
            dep = ready[0].get("id") if ready else None
        if not dep:
            raise DeployError(f"找不到 {project} 目前的正式部署。请到 Vercel 后台确认专案名称。")
        return dep

    def live_files(self, deployment_id: str) -> dict[str, str]:
        tree = self.call("GET", f"/v6/deployments/{deployment_id}/files")
        if not isinstance(tree, list) or not tree:
            raise DeployError(f"读不到部署 {deployment_id} 的档案清单（Vercel 回 {str(tree)[:200]}）。")
        live = flatten_tree(tree)
        if "package.json" not in live:
            raise DeployError(f"部署 {deployment_id} 的档案清单里没有 package.json，看起来不是 BI 网页原始码，不部署。")
        return live

    def upload(self, data: bytes) -> None:
        self.call("POST", "/v2/files", raw=data, headers={
            "Content-Type": "application/octet-stream", "x-vercel-digest": sha1(data),
            "Content-Length": str(len(data))})

    def create(self, project: str, files: list) -> dict:
        body = {"name": project, "project": project, "target": "production", "files": files}
        return self.call("POST", "/v13/deployments", body=body, query={"skipAutoDetectionConfirmation": "1"})

    def wait(self, deployment_id: str, limit_s: int = 900) -> dict:
        start, last = time.time(), None
        while True:
            d = self.call("GET", f"/v13/deployments/{deployment_id}")
            state = d.get("readyState") or d.get("status")
            if state != last:
                print(f"  状态：{state}")
                last = state
            if state in ("READY", "ERROR", "CANCELED"):
                return d
            if time.time() - start > limit_s:
                raise DeployError(f"等了 {limit_s // 60} 分钟还没建好（{state}）。请到 Vercel 后台看 {deployment_id}。")
            time.sleep(5)

    def build_log_tail(self, deployment_id: str, n: int = 25) -> list[str]:
        try:
            events = self.call("GET", f"/v3/deployments/{deployment_id}/events", query={"limit": "-1"})
        except DeployError:
            return []
        lines = [str((e.get("payload") or {}).get("text") or e.get("text") or "") for e in events or []
                 if isinstance(e, dict)]
        return [s for s in lines if s.strip()][-n:]


# ── 金钥 ─────────────────────────────────────────────────────────────────────

def _read_secret(prompt: str) -> str:
    """读金钥但不回显（避免截图外泄）。不是终端机（例如测试）时退回一般 input。"""
    import getpass
    if sys.stdin.isatty():
        print("（贴上时画面不会显示任何字，贴一次后按 Enter 即可。）")
        return getpass.getpass(prompt)
    return input(prompt)


def load_settings() -> dict:
    saved = json.loads(KEY_PATH.read_text(encoding="utf-8")) if KEY_PATH.exists() else {}
    return {**DEFAULTS, **{k: v for k, v in saved.items() if v}}


def ask_token(settings: dict) -> dict:
    """请使用者贴金钥，先用它读一次专案确认有效，再存进 vercel_token.json。"""
    print(TOKEN_HELP)
    tok = clean_token(_read_secret("\n把金钥贴在这里再按 Enter："))
    if len(tok) < 20:
        raise DeployError("没有贴到金钥（或太短），什么都没改。请照上面的步骤复制整串再试一次。")
    Vercel(tok, settings["team_id"]).call("GET", f"/v9/projects/{settings['project']}")
    settings = {**settings, "token": tok}
    KEY_PATH.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"金钥有效，已存进 {KEY_PATH.name}（这个档不会上传）。\n")
    return settings


# ── 主流程 ───────────────────────────────────────────────────────────────────

def deploy(folder: Path, check_only: bool, settings: dict) -> None:
    vc = Vercel(settings["token"], settings["team_id"])
    project, domain = settings["project"], settings["domain"]
    overlay, replaces = read_overlay(folder)
    print(f"改版目录：{folder.relative_to(ROOT) if folder.is_relative_to(ROOT) else folder}（{len(overlay)} 个档）")

    current = vc.production_deployment(project, domain)
    live = vc.live_files(current)
    print(f"线上正式版本：{current}（{len(live)} 个档）")

    plan = plan_files(live, overlay, replaces)
    for label, paths in (("新增", plan["added"]), ("换掉", plan["replaced"]), ("已经是这一版", plan["same"])):
        for p in paths:
            print(f"  {label}：{p}")
    if not plan["upload"]:
        print(f"\n线上已经是这一版，不用部署。网址：https://{domain}/")
        return
    if check_only:
        print("\n（--check 只检查，没有部署。拿掉 --check 再跑一次就会部署。）")
        return

    print(f"\n上传 {len(plan['upload'])} 个档…")
    for path, data in plan["upload"].items():
        vc.upload(data)
        print(f"  已上传 {path}")
    print("建立正式部署（Vercel 会先建置，约 30 秒到 2 分钟）…")
    created = vc.create(project, plan["files"])
    dep_id = created.get("id") or created.get("uid")
    if not dep_id:
        raise DeployError(f"Vercel 没回部署编号：{str(created)[:300]}")
    print(f"  部署编号 {dep_id}")
    done = vc.wait(dep_id)
    state = done.get("readyState") or done.get("status")
    if state != "READY":
        tail = vc.build_log_tail(dep_id)
        msg = f"建置失败（{state}）。线上网页没有被换掉，还是原本那一版。"
        if done.get("errorMessage"):
            msg += f"\n  Vercel：{done['errorMessage']}"
        if tail:
            msg += "\n  建置日志最后几行：\n    " + "\n    ".join(tail)
        raise DeployError(msg + "\n请把这段讯息贴给 Claude。")

    new_live = vc.live_files(dep_id)
    wrong = [p for p, d in overlay.items() if new_live.get(p) != sha1(d)]
    if wrong:
        raise DeployError(f"部署好了，但这些档的内容跟改版目录对不上：{', '.join(wrong)}。请把这段讯息贴给 Claude。")
    for _ in range(12):                                    # 正式网址通常几秒内就换过去
        if vc.production_deployment(project, domain) == dep_id:
            break
        time.sleep(5)
    else:
        print(f"（部署已建好，但正式网址 {domain} 还没指过来；一两分钟后再开，或到 Vercel 后台按 Promote。）")
    print(f"\n完成！正式网址：https://{domain}/")
    for p in plan["added"]:
        if p.endswith(".html"):
            print(f"  新页面：https://{domain}/{p}")


def main() -> None:
    ap = argparse.ArgumentParser(description="把 BI 网页的改版部署到 Vercel（homeworks-bi）")
    ap.add_argument("folder", nargs="?", default=str(DEFAULT_OVERLAY), help="改版目录（预设 docs/bi_web/loyalty）")
    ap.add_argument("--check", action="store_true", help="只检查，不部署")
    ap.add_argument("--set-key", action="store_true", help="换一把 Vercel 金钥")
    args = ap.parse_args()
    folder = Path(args.folder)
    if not folder.is_absolute():
        folder = ROOT / folder
    try:
        settings = load_settings()
        if args.set_key:
            ask_token(settings)
            return
        if not settings.get("token"):
            settings = ask_token(settings)
        deploy(folder, args.check, settings)
    except DeployError as e:
        sys.exit(f"\n[X] {e}")


if __name__ == "__main__":
    main()
