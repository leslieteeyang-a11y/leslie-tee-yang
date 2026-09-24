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

sys.path.insert(0, str(Path(__file__).resolve().parent))
from autocount_db import build_conn_str   # noqa: E402

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


def local_instances() -> list[str]:
    """从 Windows 登录档读出这台机器上安装的 SQL Server 执行个体（最可靠的来源）。"""
    try:
        import winreg
    except ImportError:
        return []
    found = []
    for view in (0, getattr(__import__("winreg"), "KEY_WOW64_32KEY", 0)):
        try:
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                                 r"SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL",
                                 0, winreg.KEY_READ | view)
        except OSError:
            continue
        i = 0
        while True:
            try:
                name, _, _ = winreg.EnumValue(key, i)
            except OSError:
                break
            found.append(name)
            i += 1
    servers = []
    for name in found:
        servers += ["." if name == "MSSQLSERVER" else f".\\{name}"]
    return list(dict.fromkeys(servers))


def try_connect(driver, server, user=None, password=None, database="master"):
    import pyodbc
    return pyodbc.connect(build_conn_str(driver, server, database, user, password), timeout=5)


def short_err(exc) -> str:
    return str(exc).split("]")[-1].strip()[:90]


def list_databases(conn):
    cur = conn.cursor()
    cur.execute("SELECT name FROM sys.databases WHERE state = 0 ORDER BY name")
    return [r[0] for r in cur.fetchall() if r[0] not in SYSTEM_DBS]


def choose(prompt, options, preferred=None):
    """让使用者选一个；preferred 若在清单内就排第一，直接按 Enter 即选。也接受直接打名称。"""
    if preferred and preferred in options:
        options = [preferred] + [o for o in options if o != preferred]
    for i, o in enumerate(options, 1):
        tag = "   ← 报表用这个，直接按 Enter" if preferred and o == preferred else ""
        print(f"  {i}. {o}{tag}")
    while True:
        raw = input(f"{prompt} [1-{len(options)}，Enter = 1]: ").strip()
        if not raw:
            return options[0]
        if raw.isdigit() and 1 <= int(raw) <= len(options):
            return options[int(raw) - 1]
        hit = [o for o in options if o.upper() == raw.upper()]
        if hit:
            return hit[0]
        print("  请输入清单上的编号，或直接按 Enter。")


def main():
    try:
        import pyodbc                                    # noqa: F401
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

    drv = drivers()
    if not drv:
        sys.exit("这台机器上找不到 SQL Server 的 ODBC 驱动程式。\n"
                 "请到微软官网下载安装「ODBC Driver 17 for SQL Server」后再试。")
    driver = drv[0]
    print(f"使用 ODBC 驱动：{driver}")
    if len(drv) > 1:
        print(f"（另外侦测到：{', '.join(drv[1:])}）")

    servers = local_instances()
    if servers:
        print(f"这台机器上装的 SQL Server 执行个体：{', '.join(servers)}")
        extra = input("\n若 AutoCount 的数据库在别台电脑，请照抄 AutoCount 登入画面的 Server"
                      "（例如 SERVER\\A2006）；在这台的话直接按 Enter：\n> ").strip()
    else:
        print("这台电脑没装 SQL Server，AutoCount 的数据库在别台电脑上。")
        extra = ""
        while not extra:
            extra = input("请照抄 AutoCount 登入画面「Server」那一栏（例如 SERVER\\A2006）：\n> ").strip()
    if extra:
        servers.insert(0, extra)
    servers += [x for x in INSTANCES if x not in servers]

    conn = server = user = password = None
    print("\n第一轮：用 Windows 验证试每个位址…")
    for s_ in servers:
        try:
            conn, server = try_connect(driver, s_), s_
            print(f"  {s_} … 成功")
            break
        except Exception as exc:                         # noqa: BLE001
            print(f"  {s_} … 失败：{short_err(exc)}")

    if not conn:
        print("\n第二轮：改用 SQL Server 的 sa 帐号。")
        print("  （这是 SQL Server 的密码，不是 AutoCount 的登入密码。")
        print("    AutoCount 安装程式预设的 sa 密码常见是 oconnor2008，可以先试。")
        print("    输入时画面不会显示任何字，打完按 Enter。不知道的话直接 Enter 跳过。）")
        user = input("  帐号 [sa]（若经销商建了只读帐号，打那个帐号）: ").strip() or "sa"
        password = getpass(f"  {user} 的密码: ")
        if password:
            for s_ in servers:
                try:
                    conn, server = try_connect(driver, s_, user, password), s_
                    print(f"  {s_} … 成功（帐号 {user}）")
                    break
                except Exception as exc:                 # noqa: BLE001
                    print(f"  {s_} … 失败：{short_err(exc)}")
        else:
            user = password = None

    if not conn:
        sys.exit("\n所有位址都连不上。请确认：\n"
                 "  - AutoCount 登入画面上显示的 Server 名称（照抄进来）\n"
                 "  - SQL Server 服务与 SQL Browser 服务是否启动\n"
                 "  - 密码：若只有 SERVER\\A2006 显示「Login failed」，代表连线已通、只是密码不对。\n"
                 "    请经销商给 sa 密码，或用 scripts\\sql\\create_readonly_login.sql 建只读帐号；\n"
                 "    或者到 SERVER 那台电脑上跑本脚本（Windows 验证常可直接通过）\n"
                 "然后重跑本脚本，在第一个提示直接输入正确的 Server 名称。")

    dbs = list_databases(conn)
    if not dbs:
        sys.exit("连上了，但这个执行个体里看不到任何账套数据库（可能是权限不足）。")
    print(f"\n在 {server} 上找到 {len(dbs)} 个数据库：")
    likely = [d for d in dbs if d.upper().startswith("AED")] or dbs
    if likely is not dbs:
        print("（AutoCount 账套通常以 AED 开头）")
    example = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    database = choose("请选择你们的账套", likely,
                      preferred=example["connection"].get("preferred_database"))

    cfg = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    cfg["connection"].update({
        "driver": driver, "server": server, "database": database,
        "username": user or "", "password": password or "",
        "trusted_connection": user is None,
    })
    if TARGET.exists():
        print(f"\n（{TARGET.name} 已存在，以这次选的账套 {database} 覆盖。）")
    TARGET.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"\n已写入 {TARGET}")
    if password:
        print("（内含数据库密码，此档案已被 .gitignore 排除，不会被提交）")
    print("\n下一步：python scripts\\autocount_discover.py")


if __name__ == "__main__":
    main()
