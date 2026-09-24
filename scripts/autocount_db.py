#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AutoCount（SQL Server）连线共用模块。"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "autocount.json"


def load_autocount_config():
    if not CONFIG_PATH.exists():
        sys.exit(
            "找不到 autocount.json。\n"
            "请先执行：python scripts\\autocount_setup.py\n"
            "（它会自动侦测 SQL Server 与账套并产生这个档案）\n"
            "要手动设定的话：copy autocount.example.json autocount.json 后自行编辑。"
        )
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def build_conn_str(driver: str, server: str, database: str,
                   user: str | None = None, password: str | None = None) -> str:
    """组 ODBC 连线字串。旧版「SQL Server」驱动不认得 TrustServerCertificate，
    只有 ODBC Driver 17/18 才加（18 预设强制加密，没这个会连不上自签凭证的服务器）。"""
    parts = [f"DRIVER={{{driver}}}", f"SERVER={server}", f"DATABASE={database}"]
    if user:
        parts += [f"UID={user}", f"PWD={password or ''}"]
    else:
        parts.append("Trusted_Connection=yes")
    if "ODBC Driver" in driver:
        parts.append("TrustServerCertificate=yes")
    return ";".join(parts)


def connect(cfg):
    try:
        import pyodbc
    except ImportError as exc:
        msg = str(exc)
        if "No module named" in msg:
            sys.exit("缺少 pyodbc，请先执行：pip install pyodbc")
        sys.exit(
            f"pyodbc 已安装，但载入失败：{msg}\n\n"
            "这代表缺的是系统层的 ODBC 元件，不是 pyodbc 本身，再 pip install 也没用：\n"
            "  Windows：安装微软的「ODBC Driver 17 for SQL Server」\n"
            "  Linux  ：apt install unixodbc  （或 yum install unixODBC）\n"
            "  macOS  ：brew install unixodbc"
        )

    c = cfg["connection"]
    conn_str = build_conn_str(c["driver"], c["server"], c["database"],
                              None if c.get("trusted_connection") else c.get("username"),
                              c.get("password"))
    try:
        return pyodbc.connect(conn_str, timeout=30)
    except Exception as exc:                       # noqa: BLE001
        sys.exit(
            f"连不上 AutoCount 数据库：{exc}\n\n"
            "常见原因：\n"
            "  - server 名称不对（AutoCount 多用「电脑名\\A2006」这类具名执行个体）\n"
            "  - SQL Server 未开启 TCP/IP 或 SQL Browser 服务\n"
            "  - 账号密码错误，或该账号没有读取该账套的权限\n"
            "  - 这台机器不在 AutoCount 服务器所在的网络内"
        )


def fetch(conn, sql, params=()):
    cur = conn.cursor()
    cur.execute(sql, params)
    cols = [d[0] for d in cur.description]
    return cols, cur.fetchall()


def require_report_book(cfg):
    """账套不是报表用的那个就停下来，避免抓错账套还不自知。"""
    from pathlib import Path as _P
    import json as _j
    example = _P(__file__).resolve().parent.parent / "autocount.example.json"
    want = _j.loads(example.read_text(encoding="utf-8"))["connection"].get("preferred_database")
    have = cfg["connection"]["database"]
    if want and have.upper() != want.upper():
        raise SystemExit(f"目前连的是 {have}，不是报表用的 {want}。\n"
                         f"请双击 setup_autocount.bat 重新设定（它会自动选 {want}）。")
