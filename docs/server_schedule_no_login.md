# SERVER 排程改成「没人登入也会跑」

2026-10-16 写。原因：「HomeWorks Quotes」（每 15 分钟推报价单与 DO）与「HomeWorks Monthly Report」（每月 1 号月报）
登记时都是 `LogonType = InteractiveToken`，**要有人登入 Windows 才会跑**。2026-10-14 21:00 之后 SERVER 停在登入画面，
DO 同步停了一天半（10-16 早上登入后 09:00 自动恢复）。

## 步骤（在 SERVER 上做，约 5 分钟）

事前要知道：平常登入 SERVER 的那个 Windows 账号的**密码**。账号如果没有设密码，这个选项存不进去，要先设一个。

1. 开始菜单搜寻「**工作排程器**」（英文 Task Scheduler）→ 按右键 →「**以系统管理员身分执行**」。
2. 左边点「**工作排程器程式库**」（Task Scheduler Library），中间清单找到「**HomeWorks Quotes**」，双击打开。
3. 「**一般**」（General）分页：
   - 选「**不论使用者登入与否均执行**」（Run whether user is logged on or not）。
   - 「**不要储存密码**」（Do not store password）**不要勾**。
   - 上面「执行时使用下列使用者账户」要是平常登入 SERVER 的那个账号（不要改）。
4. 按「**确定**」→ 跳出视窗输入那个账号的 Windows 密码 → 确定。
5. 回到清单，在「HomeWorks Quotes」上按右键 →「**执行**」（Run）。等 1 分钟，按 F5，「上次执行结果」要是
   「**作业已顺利完成。(0x0)**」。
6. 「**HomeWorks Monthly Report**」照第 2～4 步做一次（不用按执行；它每月 1 号才跑）。

## 改好之后

- 改了之后程式在背景跑，**不会再跳出黑色视窗**，正常。纪录在 `C:\Homeworks\HomeWorks\logs\quotes_日期.log`。
- 第 5 步结果不是 0x0：把那一栏拍照给 Claude。最常见是密码打错（重做第 3、4 步），或那个账号以后改了 Windows 密码——
  **改 Windows 密码后要回来重做第 3、4 步**，不然排程会登不进去。
- 之后若有人再双击 `setup_quotes.bat` 或 `schedule_monthly.bat`，会把排程重新登记成「要登入才跑」，要再照这份做一次。
