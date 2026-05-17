import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';

const args = new Set(process.argv.slice(2));

const config = {
  targetUrl:
    process.env.TARGET_URL ||
    'https://bigmodel.cn/claude-code?utm_source=browser-helper',
  fallbackUrl: process.env.FALLBACK_URL || 'https://www.bigmodel.cn/glm-codin',
  profileDir: path.resolve(process.env.PROFILE_DIR || '.browser-profile'),
  screenshotDir: path.resolve(process.env.SCREENSHOT_DIR || 'screenshots'),
  timeZone: process.env.TIME_ZONE || 'Asia/Shanghai',
  openTime: process.env.OPEN_TIME || '10:00:00',
  sameDayCutoffTime: process.env.SAME_DAY_CUTOFF_TIME || '10:30:00',
  warmupSeconds: readInt(process.env.WARMUP_SECONDS, 180),
  burstSeconds: readInt(process.env.BURST_SECONDS, 90),
  burstMinRetryMs: readInt(process.env.BURST_MIN_RETRY_MS, 650),
  burstMaxRetryMs: readInt(process.env.BURST_MAX_RETRY_MS, 1200),
  softRefreshEvery: readInt(process.env.SOFT_REFRESH_EVERY, 3),
  maxAttempts: readInt(process.env.MAX_ATTEMPTS, 120),
  minRetryMs: readInt(process.env.MIN_RETRY_MS, 2200),
  maxRetryMs: readInt(process.env.MAX_RETRY_MS, 9000),
  headless: readBool(process.env.HEADLESS, false),
  slowMoMs: readInt(process.env.SLOW_MO_MS, 0),
  planName: process.env.PLAN_NAME || 'Pro',
  billingName: process.env.BILLING_NAME || '连续包年',
  planSelector: process.env.PLAN_SELECTOR || '',
  billingSelector: process.env.BILLING_SELECTOR || '',
  buySelector: process.env.BUY_SELECTOR || '',
  retrySelector: process.env.RETRY_SELECTOR || '',
  browserChannel: process.env.BROWSER_CHANNEL || '',
  autoAcceptTerms: readBool(process.env.AUTO_ACCEPT_TERMS, false),
  confirmOrder: readBool(process.env.CONFIRM_ORDER, false),
  dismissReferralPromo: readBool(process.env.DISMISS_REFERRAL_PROMO, true),
  promoDismissMinMs: readInt(process.env.PROMO_DISMISS_MIN_MS, 240),
  promoDismissMaxMs: readInt(process.env.PROMO_DISMISS_MAX_MS, 640)
};

const busyPattern =
  /人太多|请求过多|访问过于频繁|系统繁忙|网络繁忙|服务繁忙|稍后再试|请稍后|重试|排队|库存不足|售罄|已抢完|限售|失败|异常/;
const terminalPattern =
  /微信|支付宝|支付方式|收银台|扫码支付|二维码|订单金额|待支付|支付剩余时间|付款/;
const forbiddenPayPattern = /立即支付|确认支付|去支付|扫码支付|付款|Pay/i;
const orderPattern = /提交订单|确认订单|创建订单|确认开通/;

main().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  await fs.mkdir(config.screenshotDir, { recursive: true });
  logConfig();

  const context = await launchContext();
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(2500);
  page.setDefaultNavigationTimeout(45000);

  await gotoTarget(page);

  if (args.has('--login')) {
    await runLoginMode(context);
    return;
  }

  const targetTime = args.has('--now')
    ? new Date()
    : nextZonedTime(
        config.openTime,
        config.timeZone,
        config.sameDayCutoffTime
      );
  const warmupTime = new Date(
    targetTime.getTime() - config.warmupSeconds * 1000
  );

  if (!args.has('--now')) {
    console.log(
      `[wait] target=${formatDate(targetTime)} warmup=${formatDate(warmupTime)}`
    );
    await waitUntil(warmupTime, 'warmup');
    await gotoTarget(page);
    await waitUntil(targetTime, 'start');
  }

  console.log('[run] starting checkout attempts');
  const result = await attemptLoop(page);
  await saveScreenshot(page, result.ok ? 'success' : 'last');

  if (result.ok) {
    process.stdout.write('\u0007');
    console.log(
      `[done] reached checkout/payment page. Please finish payment manually in the browser.`
    );
  } else {
    console.log(
      `[stop] attempts exhausted. Last state: ${result.reason || 'unknown'}`
    );
  }

  if (!config.headless) {
    await waitForEnter('Press Enter after you are done with the browser...');
  }
  await context.close();
}

async function launchContext() {
  const options = {
    headless: config.headless,
    slowMo: config.slowMoMs,
    viewport: { width: 1366, height: 900 },
    locale: 'zh-CN',
    timezoneId: config.timeZone
  };

  if (config.browserChannel) {
    options.channel = config.browserChannel;
  }

  return chromium.launchPersistentContext(config.profileDir, options);
}

async function gotoTarget(page) {
  console.log(`[nav] ${config.targetUrl}`);
  const response = await page.goto(config.targetUrl, {
    waitUntil: 'domcontentloaded'
  });
  await page.waitForLoadState('networkidle').catch(() => {});

  const bodyText = await safeBodyText(page);
  if (
    response &&
    response.status() >= 400 &&
    config.fallbackUrl &&
    config.fallbackUrl !== config.targetUrl
  ) {
    console.log(`[nav] primary returned ${response.status()}, trying fallback`);
    await page.goto(config.fallbackUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
  } else if (/404|页面不存在|not found/i.test(bodyText) && config.fallbackUrl) {
    console.log('[nav] primary looks unavailable, trying fallback');
    await page.goto(config.fallbackUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
  }
}

async function runLoginMode(context) {
  console.log('[login] Log in manually in the opened browser.');
  console.log('[login] Keep this window open until the page shows your account.');
  await waitForEnter('Press Enter here after login is complete...');
  await context.close();
}

async function attemptLoop(page) {
  let lastReason = '';
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    console.log(`[try ${attempt}/${config.maxAttempts}] selecting plan`);

    await dismissReferralPromo(page);
    await dismissNoise(page);
    await selectTargetPlan(page);
    await selectTargetBilling(page);
    await dismissReferralPromo(page);
    await maybeAcceptTerms(page);

    const terminalBefore = await isTerminalCheckout(page);
    if (terminalBefore) {
      return { ok: true, reason: 'already at checkout' };
    }

    const clicked = await clickBuyButton(page);
    if (clicked.ok) {
      console.log(`[click] ${clicked.label}`);
      await waitQuiet(page, 2000);
      await dismissReferralPromo(page);
    } else {
      lastReason = clicked.reason;
      console.log(`[miss] ${clicked.reason}`);
    }

    const handled = await handleBusyOrRetry(page);
    if (handled) {
      lastReason = 'busy popup handled';
      console.log('[busy] handled busy/retry dialog');
      await dismissReferralPromo(page);
    }

    if (await isTerminalCheckout(page)) {
      return { ok: true, reason: 'checkout detected' };
    }

    const bodyText = await safeBodyText(page);
    if (/登录|注册\/登录|验证码|滑块|安全验证/.test(bodyText)) {
      lastReason = 'login or verification required';
      console.log(
        '[hold] login/verification appears to be required. Complete it in the browser.'
      );
      await waitQuiet(page, 5000);
    }

    if (attempt % 8 === 0) {
      await saveScreenshot(page, `attempt-${attempt}`);
    }

    const delay = retryDelay(attempt, Date.now() - startedAt);
    console.log(`[wait] ${Math.round(delay)}ms before retry`);
    await page.waitForTimeout(delay);
    await softRefreshIfNeeded(page, attempt);
  }

  return { ok: false, reason: lastReason };
}

async function selectTargetPlan(page) {
  if (config.planSelector) {
    if (await clickSelector(page, config.planSelector, 'plan selector')) {
      return;
    }
  }

  const patterns = [
    new RegExp(`^\\s*${escapeRegExp(config.planName)}\\s*$`, 'i'),
    new RegExp(`${escapeRegExp(config.planName)}\\s*套餐`, 'i'),
    new RegExp(`GLM\\s*Coding\\s*Plan\\s*-?\\s*${escapeRegExp(config.planName)}`, 'i'),
    new RegExp(config.planName, 'i')
  ];

  const clicked = await clickTextLike(page, patterns, 'plan');
  if (!clicked) {
    console.log(`[select] plan text not found: ${config.planName}`);
  }
}

async function selectTargetBilling(page) {
  if (config.billingSelector) {
    if (await clickSelector(page, config.billingSelector, 'billing selector')) {
      return;
    }
  }

  const billing = config.billingName;
  const patterns = [
    new RegExp(escapeRegExp(billing), 'i'),
    /连续\s*包年/i,
    /自动续费.*年/i,
    /年付|包年|年度/i
  ];

  const clicked = await clickTextLike(page, patterns, 'billing');
  if (!clicked) {
    console.log(`[select] billing text not found: ${billing}`);
  }
}

async function maybeAcceptTerms(page) {
  if (!config.autoAcceptTerms) {
    return;
  }

  const clicked = await page
    .locator('label, .ant-checkbox-wrapper, [role="checkbox"]')
    .filter({ hasText: /我已阅读|同意|协议|条款|自动续费/ })
    .first()
    .click({ timeout: 1200 })
    .then(() => true)
    .catch(() => false);

  if (clicked) {
    console.log('[terms] accepted visible terms checkbox');
  }
}

async function clickBuyButton(page) {
  if (config.buySelector) {
    const clicked = await clickSelector(page, config.buySelector, 'buy selector');
    if (clicked) {
      return { ok: true, label: `selector:${config.buySelector}` };
    }
  }

  const result = await page.evaluate(
    ({ planName, billingName, confirmOrder }) => {
      const ctaRe =
        /立即(订阅|购买|开通|升级|续费)|马上(订阅|购买|开通)|开通|订阅|购买|升级|续费|选择|抢购/;
      const orderRe = /提交订单|确认订单|创建订单|确认开通/;
      const forbiddenPayRe = /立即支付|确认支付|去支付|扫码支付|付款|Pay/i;
      const referralPromoRe = /拼好[模摸]|邀请好友|上不封顶|赠金/;
      const disabledRe = /disabled|sold|empty|disable|unavailable/i;
      const targetPlan = new RegExp(planName, 'i');
      const targetBilling = new RegExp(billingName, 'i');

      const clickables = [
        ...document.querySelectorAll(
          'button,a,[role="button"],input[type="button"],input[type="submit"],.ant-btn'
        )
      ];

      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          rect.width > 1 &&
          rect.height > 1
        );
      };

      const elementText = (element) =>
        [
          element.innerText,
          element.value,
          element.getAttribute('aria-label'),
          element.getAttribute('title')
        ]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();

      const ancestorText = (element, depth = 6) => {
        const chunks = [];
        let current = element;
        for (let i = 0; current && i < depth; i += 1) {
          chunks.push(elementText(current));
          current = current.parentElement;
        }
        return chunks.join(' ');
      };

      let best = null;
      for (const element of clickables) {
        if (!visible(element)) continue;
        const text = elementText(element);
        const context = ancestorText(element);
        const merged = `${text} ${context}`;
        const className = String(element.className || '');
        const disabled =
          element.disabled ||
          element.getAttribute('aria-disabled') === 'true' ||
          disabledRe.test(className);

        if (!ctaRe.test(text) && !ctaRe.test(context)) continue;
        if (referralPromoRe.test(text) || referralPromoRe.test(context)) continue;
        if (forbiddenPayRe.test(text)) continue;
        if (orderRe.test(text) && !confirmOrder) continue;
        if (/已售罄|售罄|无库存|暂不可/.test(text)) continue;
        if (disabled) continue;

        let score = 0;
        if (targetPlan.test(context)) score += 40;
        if (targetPlan.test(text)) score += 15;
        if (targetBilling.test(context)) score += 25;
        if (/连续\s*包年|包年|年付|年度/.test(context)) score += 10;
        if (/立即|马上/.test(text)) score += 8;
        if (/升级|续费/.test(text)) score += 4;
        if (/选择/.test(text)) score -= 5;

        const rect = element.getBoundingClientRect();
        score -= Math.min(10, rect.top / 2000);

        if (!best || score > best.score) {
          best = {
            element,
            score,
            label: text || element.tagName,
            context: context.slice(0, 180)
          };
        }
      }

      if (!best) {
        return { ok: false, reason: 'no safe buy button found' };
      }

      best.element.scrollIntoView({ block: 'center', inline: 'center' });
      best.element.click();
      return {
        ok: true,
        label: best.label,
        score: best.score,
        context: best.context
      };
    },
    {
      planName: config.planName,
      billingName: config.billingName,
      confirmOrder: config.confirmOrder
    }
  );

  return result;
}

async function clickTextLike(page, patterns, purpose) {
  for (const pattern of patterns) {
    const locator = page.getByText(pattern).first();
    const clicked = await locator
      .click({ timeout: 1200 })
      .then(() => true)
      .catch(() => false);
    if (clicked) {
      console.log(`[select] ${purpose}: ${pattern}`);
      await waitQuiet(page, 500);
      return true;
    }
  }
  return false;
}

async function clickSelector(page, selector, purpose) {
  const clicked = await page
    .locator(selector)
    .first()
    .click({ timeout: 1500 })
    .then(() => true)
    .catch(() => false);

  if (clicked) {
    console.log(`[select] ${purpose}: ${selector}`);
    await waitQuiet(page, 500);
  }
  return clicked;
}

async function handleBusyOrRetry(page) {
  if (config.retrySelector) {
    const clicked = await clickSelector(page, config.retrySelector, 'retry selector');
    if (clicked) return true;
  }

  const text = await safeBodyText(page);
  const looksBusy = busyPattern.test(text);

  const buttonPatterns = [
    /重试|再试一次|重新尝试|刷新/,
    /确定|知道了|我知道了|关闭|取消/
  ];

  for (const pattern of buttonPatterns) {
    const clicked = await page
      .locator('button, [role="button"], a, .ant-btn')
      .filter({ hasText: pattern })
      .first()
      .click({ timeout: 1200 })
      .then(() => true)
      .catch(() => false);
    if (clicked) {
      await waitQuiet(page, 800);
      return true;
    }
  }

  if (looksBusy) {
    await page.keyboard.press('Escape').catch(() => {});
    return true;
  }

  return false;
}

async function dismissNoise(page) {
  const patterns = [/知道了|我知道了|稍后再说|关闭|取消/];
  for (const pattern of patterns) {
    await page
      .locator('button, [role="button"], a, .ant-btn')
      .filter({ hasText: pattern })
      .first()
      .click({ timeout: 800 })
      .catch(() => {});
  }
}

function isReferralPromoText(text) {
  return /拼好[模摸]|邀请好友|上不封顶|赠金/.test(compactText(text));
}

function isReferralPromoBuyText(text) {
  return /拼好[模摸]|邀请好友|上不封顶|赠金/.test(compactText(text));
}

function isReferralPromoPopupCandidate(candidate) {
  const text = compactText(candidate?.text);
  if (!isReferralPromoText(text)) return false;

  const role = compactText(candidate?.role).toLowerCase();
  const className = compactText(candidate?.className);
  if (/^(dialog|alertdialog)$/i.test(role)) return true;
  if (
    /(^|[-_\s])(modal|popup|dialog|drawer|popover)([-_\s]|$)|ant-(modal|drawer|popover|notification|message)/i.test(
      className
    )
  ) {
    return true;
  }

  const position = compactText(candidate?.position).toLowerCase();
  const zIndex = Number.parseInt(candidate?.zIndex || '', 10);
  const width = Number(candidate?.width) || 0;
  const height = Number(candidate?.height) || 0;
  const viewportWidth = Number(candidate?.viewportWidth) || 1366;
  const viewportHeight = Number(candidate?.viewportHeight) || 900;
  const hasCloseControl = Boolean(candidate?.hasCloseControl);
  const bounded =
    width >= 120 &&
    height >= 60 &&
    width < viewportWidth * 0.98 &&
    height < viewportHeight * 0.9;
  const popupPosition =
    ['fixed', 'sticky', 'absolute'].includes(position) &&
    Number.isFinite(zIndex) &&
    zIndex >= 100;

  const fullScreenOverlay =
    popupPosition &&
    width >= viewportWidth * 0.98 &&
    height >= viewportHeight * 0.9 &&
    hasCloseControl;

  return popupPosition && (bounded || fullScreenOverlay);
}

function isReferralPromoCloseControl(control) {
  const text = compactText(control?.text).replace(/[「」"'“”]/g, '');
  const ariaLabel = compactText(control?.ariaLabel);
  const title = compactText(control?.title);
  const className = compactText(control?.className);
  const visibleLabel = compactText([text, ariaLabel, title].join(' '));

  if (/captcha|验证码|验证/.test(`${visibleLabel} ${className}`)) {
    return false;
  }

  if (/拼好[模摸]|邀请好友|立即|马上|购买|订阅|开通|升级|续费|抢购/.test(visibleLabel)) {
    return false;
  }

  if (/^(x|×|close|关闭|取消|稍后再说|知道了|我知道了)$/i.test(text)) {
    return true;
  }

  return /(close|关闭|取消|modal-close|drawer-close|popover-close)/i.test(
    `${ariaLabel} ${title} ${className}`
  );
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function dismissReferralPromo(page) {
  if (!config.dismissReferralPromo) {
    return false;
  }

  const found = await page
    .evaluate(inspectReferralPromoDismiss, { click: false })
    .catch(() => ({ found: false }));
  if (!found.found) {
    return false;
  }

  const minMs = Math.max(120, config.promoDismissMinMs);
  const maxMs = Math.max(minMs, config.promoDismissMaxMs);
  const delay = Math.round(randomBetween(minMs, maxMs));
  await page.waitForTimeout(delay);

  const dismissed = await page
    .evaluate(inspectReferralPromoDismiss, { click: true })
    .catch(() => ({ found: false, clicked: false }));

  if (dismissed.clicked) {
    console.log(
      `[promo] dismissed referral promo after ${delay}ms: ${dismissed.closeLabel || 'close'}`
    );
    await waitQuiet(page, 800);
    return true;
  }

  if (dismissed.found) {
    await page.keyboard.press('Escape').catch(() => {});
    console.log(`[promo] dismissed referral promo with Escape after ${delay}ms`);
    await waitQuiet(page, 800);
    return true;
  }

  return false;
}

function inspectReferralPromoDismiss(options = {}) {
  const click = Boolean(options.click);

  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const promoTextRe = /拼好[模摸]|邀请好友|上不封顶|赠金/;
  const isPromoText = (text) => promoTextRe.test(normalize(text));
  const visible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number(style.opacity || '1') > 0 &&
      rect.width > 1 &&
      rect.height > 1
    );
  };
  const elementText = (element) =>
    [
      element.innerText,
      element.value,
      element.getAttribute('aria-label'),
      element.getAttribute('title')
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  const isPopupCandidate = (element) => {
    if (!visible(element)) return false;
    const text = elementText(element);
    if (!isPromoText(text)) return false;

    const style = window.getComputedStyle(element);
    const role = normalize(element.getAttribute('role')).toLowerCase();
    const className = normalize(element.className);
    if (/^(dialog|alertdialog)$/i.test(role)) return true;
    if (
      /(^|[-_\s])(modal|popup|dialog|drawer|popover)([-_\s]|$)|ant-(modal|drawer|popover|notification|message)/i.test(
        className
      )
    ) {
      return true;
    }

    const rect = element.getBoundingClientRect();
    const zIndex = Number.parseInt(style.zIndex || '', 10);
    const bounded =
      rect.width >= 120 &&
      rect.height >= 60 &&
      rect.width < window.innerWidth * 0.98 &&
      rect.height < window.innerHeight * 0.9;
    const popupPosition =
      ['fixed', 'sticky', 'absolute'].includes(style.position) &&
      Number.isFinite(zIndex) &&
      zIndex >= 100;
    const hasCloseControl = [
      ...element.querySelectorAll(
        'button,a,[role="button"],[aria-label],[title],.ant-modal-close,[class*="close"],[class*="Close"]'
      )
    ].some(isCloseControl);
    const fullScreenOverlay =
      popupPosition &&
      rect.width >= window.innerWidth * 0.98 &&
      rect.height >= window.innerHeight * 0.9 &&
      hasCloseControl;

    return popupPosition && (bounded || fullScreenOverlay);
  };
  const isCloseControl = (element) => {
    if (!visible(element)) return false;
    const text = normalize(elementText(element)).replace(/[「」"'“”]/g, '');
    const ariaLabel = normalize(element.getAttribute('aria-label'));
    const title = normalize(element.getAttribute('title'));
    const className = normalize(element.className);
    const visibleLabel = normalize([text, ariaLabel, title].join(' '));

    if (/captcha|验证码|验证/.test(`${visibleLabel} ${className}`)) {
      return false;
    }

    if (/拼好[模摸]|邀请好友|立即|马上|购买|订阅|开通|升级|续费|抢购/.test(visibleLabel)) {
      return false;
    }
    if (/^(x|×|close|关闭|取消|稍后再说|知道了|我知道了)$/i.test(text)) {
      return true;
    }
    return /(close|关闭|取消|modal-close|drawer-close|popover-close)/i.test(
      `${ariaLabel} ${title} ${className}`
    );
  };

  const targetedSelector = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    '.ant-modal',
    '.ant-modal-root',
    '.ant-drawer',
    '.ant-popover',
    '.ant-notification-notice',
    '.ant-message-notice',
    '[class*="modal"]',
    '[class*="Modal"]',
    '[class*="popup"]',
    '[class*="Popup"]',
    '[class*="dialog"]',
    '[class*="Dialog"]',
    '[class*="drawer"]',
    '[class*="Drawer"]'
  ].join(',');
  const targeted = [...document.querySelectorAll(targetedSelector)];
  const broad = [...document.querySelectorAll('div,section,aside')];
  const candidates = [...new Set([...targeted, ...broad])].filter(isPopupCandidate);

  for (const candidate of candidates) {
    const closeControls = [
      ...candidate.querySelectorAll(
        'button,a,[role="button"],[aria-label],[title],.ant-modal-close,[class*="close"],[class*="Close"]'
      )
    ];
    const closeControl = closeControls.find(isCloseControl);
    if (!closeControl) {
      return {
        found: true,
        clicked: false,
        reason: 'no close control',
        text: elementText(candidate).slice(0, 120)
      };
    }

    const closeLabel = elementText(closeControl) || closeControl.getAttribute('class') || 'close';
    if (click) {
      closeControl.click();
    }

    return {
      found: true,
      clicked: click,
      closeLabel: normalize(closeLabel).slice(0, 80),
      text: elementText(candidate).slice(0, 120)
    };
  }

  return { found: false };
}

async function isTerminalCheckout(page) {
  const text = await safeBodyText(page);
  if (terminalPattern.test(text)) return true;

  if (!config.confirmOrder && orderPattern.test(text)) {
    console.log('[hold] order confirmation page detected; manual action required');
    return true;
  }

  return false;
}

async function softRefreshIfNeeded(page, attempt) {
  if (config.softRefreshEvery <= 0 || attempt % config.softRefreshEvery !== 0) {
    return;
  }

  const text = await safeBodyText(page);
  if (/售罄|已抢完|库存不足|系统繁忙|网络繁忙|稍后再试/.test(text)) {
    console.log('[nav] soft refresh');
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
  }
}

async function safeBodyText(page) {
  return page
    .locator('body')
    .innerText({ timeout: 1200 })
    .catch(() => '');
}

async function waitQuiet(page, ms) {
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
  await page.waitForTimeout(Math.min(ms, 1000));
}

async function saveScreenshot(page, name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(config.screenshotDir, `${stamp}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  console.log(`[shot] ${file}`);
}

function retryDelay(attempt, elapsedMs) {
  if (elapsedMs < config.burstSeconds * 1000) {
    return randomBetween(config.burstMinRetryMs, config.burstMaxRetryMs);
  }

  const base = Math.min(
    config.maxRetryMs,
    config.minRetryMs * Math.pow(1.16, attempt - 1)
  );
  const jitter = base * (Math.random() * 0.35);
  return Math.min(config.maxRetryMs, base + jitter);
}

function randomBetween(min, max) {
  return min + Math.random() * Math.max(0, max - min);
}

async function waitUntil(date, label) {
  while (Date.now() < date.getTime()) {
    const remaining = date.getTime() - Date.now();
    const seconds = Math.ceil(remaining / 1000);
    if (seconds <= 10 || seconds % 30 === 0) {
      console.log(`[wait:${label}] ${seconds}s`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, remaining)));
  }
}

async function waitForEnter(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  await rl.question(prompt);
  rl.close();
}

function nextZonedTime(timeText, timeZone, sameDayCutoffTime = '10:30:00', now = new Date()) {
  const { hour, minute, second } = parseTimeText(timeText, 'OPEN_TIME');
  const cutoff = parseTimeText(sameDayCutoffTime, 'SAME_DAY_CUTOFF_TIME');
  const parts = zonedParts(now, timeZone);
  let candidate = zonedTimeToUtc(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour,
      minute,
      second
    },
    timeZone
  );
  const cutoffTime = zonedTimeToUtc(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: cutoff.hour,
      minute: cutoff.minute,
      second: cutoff.second
    },
    timeZone
  );

  if (
    candidate.getTime() <= now.getTime() &&
    cutoffTime.getTime() <= now.getTime()
  ) {
    const tomorrow = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
    const next = zonedParts(tomorrow, 'UTC');
    candidate = zonedTimeToUtc(
      {
        year: next.year,
        month: next.month,
        day: next.day,
        hour,
        minute,
        second
      },
      timeZone
    );
  }

  return candidate;
}

function parseTimeText(timeText, label) {
  const [hour, minute, second] = timeText.split(':').map(Number);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second)
  ) {
    throw new Error(`Invalid ${label}: ${timeText}`);
  }

  return { hour, minute, second };
}

function zonedTimeToUtc(parts, timeZone) {
  const guess = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    )
  );
  const offset = timeZoneOffsetMs(timeZone, guess);
  return new Date(guess.getTime() - offset);
}

function timeZoneOffsetMs(timeZone, date) {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asUtc - date.getTime();
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  );

  return values;
}

function formatDate(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: config.timeZone,
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(date);
}

function readInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBool(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function logConfig() {
  console.log('[config]');
  console.log(`  targetUrl=${config.targetUrl}`);
  console.log(`  timeZone=${config.timeZone}`);
  console.log(`  openTime=${config.openTime}`);
  console.log(`  sameDayCutoffTime=${config.sameDayCutoffTime}`);
  console.log(
    `  burst=${config.burstSeconds}s ${config.burstMinRetryMs}-${config.burstMaxRetryMs}ms`
  );
  console.log(`  plan=${config.planName}`);
  console.log(`  billing=${config.billingName}`);
  console.log(`  maxAttempts=${config.maxAttempts}`);
  console.log(`  retry=${config.minRetryMs}-${config.maxRetryMs}ms`);
  console.log(`  softRefreshEvery=${config.softRefreshEvery}`);
  console.log(`  confirmOrder=${config.confirmOrder}`);
  console.log(`  autoAcceptTerms=${config.autoAcceptTerms}`);
  console.log(
    `  dismissReferralPromo=${config.dismissReferralPromo} reaction=${config.promoDismissMinMs}-${config.promoDismissMaxMs}ms`
  );
}
