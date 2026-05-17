# GLM Coding Plan 浏览器订阅助手

这个工具用 Playwright 打开真实浏览器页面，不直接调用订阅 API，不做验证码绕过、自动支付、隐藏自动化特征或并发刷新。默认目标是 `Pro` + `连续包年`，遇到“人太多 / 系统繁忙 / 重试”等提示时会低频退避重试；进入确认订单、收银台或支付页后停止，后续由你手动确认和付款。

## 安装

```bash
npm install
npm run prepare-browser
```

## 第一次登录

```bash
npm run login
```

浏览器打开后手动登录智谱账号。登录完成后回到终端按 Enter，登录态会保存在 `.browser-profile/`。

## 每天 10 点运行

建议 9:55 左右启动：

```bash
npm run start
```

脚本会默认按北京时间 10:00:00 开始尝试；如果 10:30:00 之前启动，会继续抢当天这一场，10:30:00 之后才排到第二天。想立即测试当前页面选择逻辑：

```bash
npm run start:now
```

## 常用配置

直接用环境变量覆盖默认值：

```bash
TARGET_URL="https://bigmodel.cn/claude-code" MAX_ATTEMPTS=180 npm run start
```

可配置项：

- `TARGET_URL`：订阅页面地址，默认 `https://bigmodel.cn/claude-code?utm_source=browser-helper`
- `FALLBACK_URL`：主地址不可用时的备选地址，默认 `https://www.bigmodel.cn/glm-codin`
- `OPEN_TIME`：开始时间，默认 `10:00:00`
- `SAME_DAY_CUTOFF_TIME`：当天场次截止判断时间，默认 `10:30:00`；这个时间前启动仍按当天处理
- `TIME_ZONE`：时区，默认 `Asia/Shanghai`
- `PLAN_NAME`：套餐，默认 `Pro`
- `BILLING_NAME`：周期，默认 `连续包年`
- `BURST_SECONDS`：10 点后快速尝试窗口，默认 `90` 秒
- `BURST_MIN_RETRY_MS` / `BURST_MAX_RETRY_MS`：快速窗口内重试间隔，默认 `650` 到 `1200`
- `SOFT_REFRESH_EVERY`：繁忙状态下每多少次尝试做一次页面软刷新，默认 `3`；设为 `0` 可关闭
- `MAX_ATTEMPTS`：最多尝试次数，默认 `120`
- `MIN_RETRY_MS` / `MAX_RETRY_MS`：重试退避范围，默认 `2200` 到 `9000`
- `AUTO_ACCEPT_TERMS`：是否自动勾选可见协议复选框，默认 `0`
- `CONFIRM_ORDER`：是否点击“确认订单 / 提交订单”类按钮，默认 `0`
- `DISMISS_REFERRAL_PROMO`：是否自动关闭“拼好模 / 邀请好友 / 赠金”类推广弹窗，默认 `1`
- `PROMO_DISMISS_MIN_MS` / `PROMO_DISMISS_MAX_MS`：关闭推广弹窗前的随机反应时间，默认 `240` 到 `640`
- `PLAN_SELECTOR` / `BILLING_SELECTOR` / `BUY_SELECTOR` / `RETRY_SELECTOR`：页面改版时可手工指定 CSS 选择器

## 使用建议

先用 `npm run login` 确保账号已登录，并在 9:55 左右启动 `npm run start`。如果页面需要验证码、短信、安全校验或支付确认，脚本会停在浏览器里等你手动处理。

脚本会把失败和关键尝试截图保存到 `screenshots/`，如果没有点到正确按钮，可以根据截图和页面 DOM 设置 `BUY_SELECTOR` 等选择器。
