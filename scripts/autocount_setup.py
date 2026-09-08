#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""自动侦测 AutoCount 的 SQL Server 与账套，产生 autocount.json。

在办公室那台连得到 AutoCount 的电脑上执行：

    python scripts/autocount_setup.py

它会：
  1. 找出这台机器上可用的 ODBC 驱动程式
  2. 逐一尝试常见的 SQL Server 执行个体（A2006 / SQLEXPRESS / 预设执行个体…）
  3. 连上以后列出所有账套（AutoCount 的账本数据库），让你选
  4. 把连线资料写进 autocount.json

连不上的话，会印出实际的错误讯息与该怎么处理。
"""

import json
import sys
from getpass import getpass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE = ROOT / "autocount.example.json"
TARGET = ROOT / "autocount.json"

# AutoCount 常见的执行个体名称。A2006 是 AutoCount 安装时的预设具名执行个体。
INSTANCES = [r".\A2006", r"localhost\A2006", r".\SQLEXPRESS",
             r"localhost\SQLEXPRESS", ".", "localhost", r".\AUTOCOUNT"]
SYSTEM_DBS = {"master", "tempdb", "model", "msdb", "ReportServer",
              "ReportServerTempDB", "AutoCountDBSetting"}


def drivers():
    import pyodbc
    found = [d for d in pyodbc.drivers() if "SQL Server" in d]
    # 越新的驱动排越前面；不在清单内的排最后
    rank = {"ODBC Driver 18 for SQL Server": 0,
            "ODBC Driver 17 for SQL Server": 1,
            "ODBC Driver 13 for SQL Server": 2,
            "SQL Server Native Client 11.0": 3,
            "SQL Server": 9}
    found.sort(key=lambda d: rank.get(d, 5))
    return found


def try_connect(driver, server, user=None, password=None, database="master"):
    import pyodbc
    parts = [f"DRIVER={{{driver}}}", f"SERVER={server}", f"DATABASE={database}",
             "TrustServerCertificate=yes"]
    if user:
        parts += [f"UID={user}", f"PWD={password or ''}"]
    else:
        parts.append("Trusted_Connection=yes")
    return pyodbc.connect(";".join(parts), timeout=5)


def list_databases(conn):
    cur = conn.cursor()
    cur.execute("SELECT name FROM sys.databases WHERE state = 0 ORDER BY name")
    return [r[0] for r in cur.fetchall() if r[0] not in SYSTEM_DBS]


def choose(prompt, options):
    for i, o in enumerate(options, 1):
        print(f"  {i}. {o}")
    while True:
        raw = input(f"{prompt} [1-{len(options)}]: ").strip()
        if raw.isdigit() and 1 <= int(raw) <= len(options):
            return options[int(raw) - 1]
        print("  请输入清单上的编号。")


def main():
    try:
        import pyodbc                                    # noqa: F401
    except ImportError:
        sys.exit("缺少 pyodbc，请先执行：pip install pyodbc")

    drv = drivers()
    if not drv:
        sys.exit("这台机器上找不到 SQL Server 的 ODBC 驱动程式。\n"
                 "请到微软官网下载安装「ODBC Driver 17 for SQL Server」后再试。")
    driver = drv[0]
    print(f"使用 ODBC 驱动：{driver}")
    if len(drv) > 1:
        print(f"（另外侦测到：{', '.join(drv[1:])}）")

    servers = list(INSTANCES)
    extra = input("\n若已知 SQL Server 位址请直接输入（例如 SERVERPC\\A2006），"
                  "留空则自动尝试常见位址：\n> ").strip()
    if extra:
        servers.insert(0, extra)

    conn = server = user = password = None
    for s in servers:
        print(f"\n尝试 {s} …", end=" ")
        try:                                             # 先试 Windows 验证
            conn, server = try_connect(driver, s), s
            print("成功（Windows 验证）")
            break
        except Exception as exc:                         # noqa: BLE001
            msg = str(exc).split("]")[-1].strip()[:90]
            print(f"Windows 验证失败：{msg}")
        try:                                             # 再试 sa
            if user is None:
                user = input("  改用 SQL 帐号登入，帐号（预设 sa，留空跳过此位址）: ").strip() or None
                if user:
                    password = getpass("  密码: ")
            if user:
                conn, server = try_connect(driver, s, user, password), s
                print(f"  成功（SQL 帐号 {user}）")
                break
        except Exception as exc:                         # noqa: BLE001
            print(f"  SQL 帐号失败：{str(exc).split(']')[-1].strip()[:90]}")

    if not conn:
        sys.exit("\n所有位址都连不上。请确认：\n"
                 "  - AutoCount 登入画面上显示的 Server 名称（照抄进来）\n"
                 "  - SQL Server 服务与 SQL Browser 服务是否启动\n"
                 "  - 这台机器是否在 AutoCount 服务器所在的网络内\n"
                 "然后重跑本脚本，在第一个提示直接输入正确的 Server 名称。")

    dbs = list_databases(conn)
    if not dbs:
        sys.exit("连上了，但这个执行个体里看不到任何账套数据库（可能是权限不足）。")
    print(f"\n在 {server} 上找到 {len(dbs)} 个数据库：")
    likely = [d for d in dbs if d.upper().startswith("AED")] or dbs
    if likely is not dbs:
        print("（AutoCount 账套通常以 AED 开头）")
    database = choose("请选择你们的账套", likely)

    cfg = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    cfg["connection"].update({
        "driver": driver, "server": server, "database": database,
        "username": user or "", "password": password or "",
        "trusted_connection": user is None,
    })
    if TARGET.exists():
        if input(f"\n{TARGET.name} 已存在，要覆盖吗？(y/N) ").strip().lower() != "y":
            sys.exit("已取消，未修改既有档案。")
    TARGET.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"\n已写入 {TARGET}")
    if password:
        print("（内含数据库密码，此档案已被 .gitignore 排除，不会被提交）")
    print("\n下一步：python scripts\\autocount_discover.py")


if __name__ == "__main__":
    main()
