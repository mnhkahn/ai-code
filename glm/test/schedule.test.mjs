import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadScheduler(nowIso) {
  const source = fs.readFileSync(new URL('../src/glm-coding-assistant.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function nextZonedTime');
  const end = source.indexOf('function formatDate');
  assert.notEqual(start, -1, 'nextZonedTime function not found');
  assert.notEqual(end, -1, 'formatDate function not found');

  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(nowIso);
        return;
      }
      super(...args);
    }

    static now() {
      return new RealDate(nowIso).getTime();
    }
  }

  const context = {
    Date: FixedDate,
    Intl,
    Number,
    module: { exports: {} }
  };

  vm.runInNewContext(
    `${source.slice(start, end)}
module.exports = { nextZonedTime };`,
    context
  );
  return context.module.exports;
}

function zhTime(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(date);
}

test('uses today when started after 10:00 but before the 10:30 same-day cutoff', () => {
  const { nextZonedTime } = loadScheduler('2026-05-16T02:10:19.000Z');

  const target = nextZonedTime('10:00:00', 'Asia/Shanghai', '10:30:00');

  assert.equal(zhTime(target), '2026/5/16 10:00:00');
});

test('uses tomorrow once the same-day cutoff has arrived', () => {
  const { nextZonedTime } = loadScheduler('2026-05-16T02:30:00.000Z');

  const target = nextZonedTime('10:00:00', 'Asia/Shanghai', '10:30:00');

  assert.equal(zhTime(target), '2026/5/17 10:00:00');
});
