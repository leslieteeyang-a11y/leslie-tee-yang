# HomeWorks 营运系统 — 给接手这个仓库的 Claude

这是 HomeWorks（Hemos 卫浴 / 门锁品牌，马来西亚）的营运系统，分支
`claude/monthly-data-prep-vtcnct`。使用者 Leslie 不写程式；你是开发者，
他是决策者与「手」。**用中文回覆。**

## 这台电脑是什么

若你在 Windows 上跑，这台很可能就是办公室里连得到 AutoCount 的机器。
AutoCount 的资料在内网的 SQL Server（具名执行个体常为 `A2006`），账套是
`AED_` 开头的数据库。渠道靠客户账号（Debtor Code）分辨；订单逐笔含 SKU。

## 第一次打开时要做的事（照顺序）

1. `python -m pip install -r requirements.txt`
2. `run_web.bat` → 浏览器开 http://localhost:8000 看到库存页（示范资料）即通过。
   确认后停掉它（关视窗或 Ctrl+C）。
3. `python scripts\autocount_setup.py` → 自动侦测 SQL Server、列账套让使用者选、
   写出 `autocount.json`。连不上时脚本会说该检查什么；**Server 名称照抄
   AutoCount 登入画面**。
4. `python scripts\autocount_discover.py` → 产生 `discovery_<账套>.txt`。
5. 读那个档案，依实际表名栏名修正 `autocount.json` 的 `schema`、
   `channel_rules.map`（哪个 Debtor Code 是 Shopee / Lazada / …）、`brand_filter`，
   以及 `webapp/sources/autocount.py` 的预设 SQL（可用 `autocount.json` 的
   `webapp.sql` 覆写而不改程式）。
6. `python scripts\autocount_extract.py 2026-08 --dry-run` 看 SQL，没问题再拿掉
   `--dry-run` 真的抓；接着 `python scripts\generate_report.py 2026-08`，
   把结果与 `data/2026-08.json`（纸本录入的对照值）比对。
7. 再开 `run_web.bat`，这次会自动接 AutoCount；确认库存与出货页有真实资料。

遇到错误自己处理；需要使用者决定的（选账套、密码、哪个客户对应哪个渠道）才问。

## 绝对不要做的事

- **不要对 AutoCount 写入任何东西**（INSERT / UPDATE / DELETE / 存储过程）。
  目前所有整合都是只读；写入要另开专案、用 AutoCount 官方 SDK、先在测试账套验证。
- 不要提交 `autocount.json`、`discovery_*.txt`（已在 .gitignore；内含密码 / 结构）。
- 不要把示范资料（`webapp/sources/mock.py`）的数字当成真实数据。

## 专案地图

| 路径 | 用途 |
|---|---|
| `webapp/` | 营运入口网页（FastAPI + Jinja2）。`sources/` 是资料层：`__init__` 定义介面，`mock` 示范资料，`autocount` 只读实作 |
| `scripts/autocount_*.py` | 连线、侦测、探查、抓月报数据 |
| `scripts/generate_report.py` | `data/YYYY-MM.json` → `output/月度报表_YYYY-MM.xlsx` |
| `config.json` | SKU 趋势清单、报表渠道栏 |
| `autocount.example.json` | 连线与对照设定模板 |
| `tests/` | `python -m pytest tests -q`，14 个行为测试（用示范资料，不需 AutoCount） |
| `README.md` | 使用者视角的完整说明 |

## 后续路线（使用者已同意的顺序）

1. 真实数据接通（上面第 3–7 步）
2. 管理仪表板：各渠道销量、Top / Bottom SKU、低库存警示（月报逻辑搬上网页）
3. 登入与权限（开到办公室以外之前必须有）
4. 写入 AutoCount 的 POC：一条流程、测试账套、证明失败时不留半张单、重跑不重复过账

## 写码惯例

- Python 3.11+，型别标注，中文注释；错误讯息要告诉使用者**该检查什么**，不要只丢 traceback
- 合计 / 百分比在 Excel 里用公式，不写死数值
- 改动后跑测试；新功能补测试
- 提交讯息说明「为什么」，不只「做了什么」
