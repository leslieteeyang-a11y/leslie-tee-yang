# -*- coding: utf-8 -*-
"""登入与权限：不连 Supabase，用假的 sign_in 测流程。"""

import os
import time

import pytest
from fastapi.testclient import TestClient

os.environ["HW_SOURCE"] = "mock"

from webapp import auth                            # noqa: E402
from webapp.main import app                        # noqa: E402


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("HW_AUTH", "on")
    auth.reset_config()
    monkeypatch.setattr(auth, "config", lambda: auth.AuthConfig(
        enabled=True, url="https://x.supabase.co", publishable_key="pk", allowed_roles=("owner",),
        session_hours=1, secret="test-secret"))

    def fake_sign_in(email, password):
        if email == "boss@x.com" and password == "right":
            return auth.User(email=email, role="owner")
        if email == "staff@x.com" and password == "right":
            raise auth.LoginError("这个账号没有营运网页的权限。")
        raise auth.LoginError("email 或密码不对。")
    monkeypatch.setattr(auth, "sign_in", fake_sign_in)
    yield TestClient(app, follow_redirects=False)
    auth.reset_config()


def test_pages_require_login(client):
    r = client.get("/dashboard")
    assert r.status_code == 303 and r.headers["location"] == "/login?next=/dashboard"
    assert client.get("/api/inventory").status_code == 401
    assert client.get("/health").status_code == 200          # 健康检查不用登入


def test_wrong_password_stays_on_login(client):
    r = client.post("/login", data={"email": "boss@x.com", "password": "nope", "next": "/inventory"})
    assert r.status_code == 401 and "email 或密码不对" in r.text
    assert auth.COOKIE not in r.cookies


def test_role_without_permission_is_rejected(client):
    r = client.post("/login", data={"email": "staff@x.com", "password": "right"})
    assert r.status_code == 401 and "没有营运网页的权限" in r.text


def test_login_then_browse_then_logout(client):
    r = client.post("/login", data={"email": "boss@x.com", "password": "right", "next": "/inventory"})
    assert r.status_code == 303 and r.headers["location"] == "/inventory"
    assert auth.COOKIE in r.cookies
    page = client.get("/inventory")
    assert page.status_code == 200 and "boss@x.com" in page.text and "登出" in page.text
    assert client.get("/api/inventory").status_code == 200
    r = client.get("/logout")
    assert r.status_code == 303
    client.cookies.clear()
    assert client.get("/inventory").status_code == 303


def test_next_cannot_redirect_offsite(client):
    r = client.post("/login", data={"email": "boss@x.com", "password": "right", "next": "//evil.com"})
    assert r.headers["location"] == "/dashboard"


def test_cookie_tamper_and_expiry():
    u = auth.User("boss@x.com", "owner")
    good = auth.make_cookie(u, "s3cret", hours=1)
    assert auth.read_cookie(good, "s3cret") == u
    assert auth.read_cookie(good, "other-secret") is None                       # 签章不符
    payload, sig = good.rsplit(".", 1)
    assert auth.read_cookie(payload[:-2] + "AA." + sig, "s3cret") is None      # 内容被改
    old = auth.make_cookie(u, "s3cret", hours=1, now=time.time() - 7200)
    assert auth.read_cookie(old, "s3cret") is None                             # 过期
    assert auth.read_cookie(None, "s3cret") is None


def test_auth_off_when_no_config(monkeypatch):
    monkeypatch.setenv("HW_AUTH", "off")
    auth.reset_config()
    c = TestClient(app)
    assert c.get("/dashboard").status_code == 200
    assert c.get("/login", follow_redirects=False).status_code == 307        # 没启用登入就直接进仪表板
    auth.reset_config()
