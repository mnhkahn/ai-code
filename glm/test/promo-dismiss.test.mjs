import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadPromoHelpers() {
  const source = fs.readFileSync(
    new URL('../src/glm-coding-assistant.mjs', import.meta.url),
    'utf8'
  );
  const start = source.indexOf('function isReferralPromoText');
  const end = source.indexOf('async function dismissReferralPromo');
  assert.notEqual(start, -1, 'isReferralPromoText function not found');
  assert.notEqual(end, -1, 'dismissReferralPromo function not found');

  const context = {
    Number,
    RegExp,
    String,
    module: { exports: {} }
  };

  vm.runInNewContext(
    `${source.slice(start, end)}
module.exports = {
  isReferralPromoText,
  isReferralPromoBuyText,
  isReferralPromoPopupCandidate,
  isReferralPromoCloseControl
};`,
    context
  );
  return context.module.exports;
}

test('recognizes referral promo wording without treating buy errors as promo', () => {
  const { isReferralPromoText, isReferralPromoBuyText } = loadPromoHelpers();

  assert.equal(isReferralPromoText('立即「拼好模」'), true);
  assert.equal(isReferralPromoText('邀请好友，拼好模，最高 20% 赠金，上不封顶！'), true);
  assert.equal(isReferralPromoText('拼好摸'), true);
  assert.equal(isReferralPromoText('抢购人数过多，请刷新再试'), false);
  assert.equal(isReferralPromoBuyText('立即「拼好模」'), true);
  assert.equal(
    isReferralPromoBuyText('Pro 连续包年 抢购人数过多，请刷新再试'),
    false
  );
});

test('only treats promo wording as dismissible when it appears in popup-like containers', () => {
  const { isReferralPromoPopupCandidate } = loadPromoHelpers();

  assert.equal(
    isReferralPromoPopupCandidate({
      text: '邀请好友，拼好模，最高 20% 赠金，上不封顶！',
      role: '',
      className: '',
      position: 'static',
      zIndex: 'auto',
      width: 1140,
      height: 120,
      viewportWidth: 1366,
      viewportHeight: 900
    }),
    false
  );

  assert.equal(
    isReferralPromoPopupCandidate({
      text: '邀请好友，拼好模，最高 20% 赠金，上不封顶！',
      role: 'dialog',
      className: '',
      position: 'static',
      zIndex: 'auto',
      width: 560,
      height: 320,
      viewportWidth: 1366,
      viewportHeight: 900
    }),
    true
  );

  assert.equal(
    isReferralPromoPopupCandidate({
      text: '邀请好友，拼好摸，最高 20% 赠金，上不封顶！',
      role: '',
      className: 'ant-modal promo-card',
      position: 'static',
      zIndex: 'auto',
      width: 560,
      height: 320,
      viewportWidth: 1366,
      viewportHeight: 900
    }),
    true
  );

  assert.equal(
    isReferralPromoPopupCandidate({
      text: '邀请好友赢赠金，上不封顶！复制专属链接或者发送海报邀请好友',
      role: '',
      className: 'invite-overlay',
      position: 'fixed',
      zIndex: '1000',
      width: 1366,
      height: 900,
      viewportWidth: 1366,
      viewportHeight: 900,
      hasCloseControl: true
    }),
    true
  );
});

test('allows close controls but rejects the promo call-to-action', () => {
  const { isReferralPromoCloseControl } = loadPromoHelpers();

  assert.equal(
    isReferralPromoCloseControl({
      text: '',
      ariaLabel: 'Close',
      title: '',
      className: 'ant-modal-close'
    }),
    true
  );
  assert.equal(
    isReferralPromoCloseControl({
      text: 'x',
      ariaLabel: '',
      title: '',
      className: ''
    }),
    true
  );
  assert.equal(
    isReferralPromoCloseControl({
      text: '立即「拼好模」',
      ariaLabel: '',
      title: '',
      className: 'primary-button'
    }),
    false
  );
  assert.equal(
    isReferralPromoCloseControl({
      text: '',
      ariaLabel: '',
      title: '',
      className: 'tencent-captcha-dy__header-close'
    }),
    false
  );
});
