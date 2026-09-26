# -*- coding: utf-8 -*-
"""登入与权限：营运网页沿用 HomeWorks BI（Supabase）的账号。

流程：/login 输入 email + 密码 → 送去 Supabase Auth 验证 → 再问 BI 的 bi_role() 这个人是什么角色
→ 角色在 allowed_roles 里才发 session cookie（HMAC 签章，浏览器改不了）。
没有 autocount.json（示范模式）或环境变数 HW_AUTH=off 时不启用登入，方便本机开发与测试。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "autocount.json"
EXAMPLE = ROOT / "autocount.example.json"
COOKIE = "hw_session"


@dataclass
class User:
    email: str
    role: str


@dataclass
class AuthConfig:
    enabled: bool
    url: str = ""
    publishable_key: str = ""
    allowed_roles: tuple[str, ...] = ("owner",)
    session_hours: int = 12
    secret: str = ""


def _read(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


_cfg: AuthConfig | None = None


def config() -> AuthConfig:
    """读设定（autocount.json 没写的栏位用 autocount.example.json 的预设）。"""
    global _cfg
    if _cfg is not None:
        return _cfg
    mode = os.environ.get("HW_AUTH", "").lower()
    if mode == "off" or (mode != "on" and not CONFIG.exists()):
        _cfg = AuthConfig(enabled=False)
        return _cfg
    example, local = _read(EXAMPLE), _read(CONFIG)
    sb = {**(example.get("supabase") or {}), **(local.get("supabase") or {})}
    web = {**(example.get("web") or {}), **(local.get("web") or {})}
    secret = web.get("cookie_secret") or ""
    if not secret:                                   # 第一次启动：产生签章金钥并写回，重启后 session 仍有效
        secret = secrets.token_urlsafe(32)
        if CONFIG.exists():
            local.setdefault("web", {})["cookie_secret"] = secret
            CONFIG.write_text(json.dumps(local, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _cfg = AuthConfig(enabled=True, url=sb.get("url", "").rstrip("/"), publishable_key=sb.get("publishable_key", ""),
                      allowed_roles=tuple(web.get("allowed_roles") or ["owner"]),
                      session_hours=int(web.get("session_hours") or 12), secret=secret)
    return _cfg


def reset_config() -> None:
    global _cfg
    _cfg = None


# ------------------------------------------------------------- Supabase
class LoginError(Exception):
    """给使用者看的登入失败原因。"""


def _post_json(url: str, headers: dict, body: dict | None):
    data = json.dumps(body).encode("utf-8") if body is not None else b""
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={**headers, "Content-Type": "application/json", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8") or "null")


def sign_in(email: str, password: str) -> User:
    """用 Supabase 账号密码登入，再向 BI 问角色。失败抛 LoginError。"""
    c = config()
    if not c.url or not c.publishable_key:
        raise LoginError("网页还没设定 Supabase（autocount.json 的 supabase.url / publishable_key）。")
    try:
        tok = _post_json(f"{c.url}/auth/v1/token?grant_type=password",
                         {"apikey": c.publishable_key}, {"email": email, "password": password})
    except urllib.error.HTTPError as e:
        if e.code in (400, 401, 403):
            raise LoginError("email 或密码不对。") from None
        raise LoginError(f"Supabase 回应 {e.code}，请稍后再试。") from None
    except urllib.error.URLError as e:
        raise LoginError(f"连不上 Supabase（{e.reason}），请检查这台电脑的网路。") from None
    access = tok.get("access_token")
    if not access:
        raise LoginError("email 或密码不对。")
    try:
        role = _post_json(f"{c.url}/rest/v1/rpc/bi_role",
                          {"apikey": c.publishable_key, "Authorization": f"Bearer {access}"}, {})
    except (urllib.error.HTTPError, urllib.error.URLError):
        role = None
    role = (role or "").strip() if isinstance(role, str) else ""
    if role not in c.allowed_roles:
        raise LoginError("这个账号没有营运网页的权限。")
    return User(email=(tok.get("user") or {}).get("email") or email, role=role)


# --------------------------------------------------------- session cookie
def _sign(payload: bytes, secret: str) -> str:
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def make_cookie(user: User, secret: str, hours: int, now: float | None = None) -> str:
    body = json.dumps({"e": user.email, "r": user.role, "x": int((now or time.time()) + hours * 3600)}).encode("utf-8")
    payload = base64.urlsafe_b64encode(body).decode("ascii").rstrip("=")
    return f"{payload}.{_sign(payload.encode('ascii'), secret)}"


def read_cookie(value: str | None, secret: str, now: float | None = None) -> User | None:
    """签章不符、过期、格式坏掉 → None（视为没登入）。"""
    if not value or "." not in value or not secret:
        return None
    payload, sig = value.rsplit(".", 1)
    if not hmac.compare_digest(sig, _sign(payload.encode("ascii"), secret)):
        return None
    try:
        body = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        if body["x"] < (now or time.time()):
            return None
        return User(email=body["e"], role=body["r"])
    except (ValueError, KeyError, TypeError):
        return None
