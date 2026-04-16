#!/usr/bin/env node
// 持久化 + 重试 + 阶段进度 单元测试
// 不启动 HTTP server，直接通过 module.exports.__test 操作内部状态

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// 确保使用独立的 queue 文件路径：以 NODE_ENV=test 或自定义数据目录隔离。
// 这里用简单方案：load server，拿到 QUEUE_FILE 路径，备份并 restore。

const srv = require('./server.js');
const T = srv.__test;

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  PASS:', name); },
    (e) => { fail++; console.error('  FAIL:', name, '-', e.message); if (process.env.DEBUG) console.error(e.stack); }
  );
}

// ── 备份真实 QUEUE_FILE，测试后 restore ──
const QUEUE_FILE = T.QUEUE_FILE;
let backupContent = null;
if (fs.existsSync(QUEUE_FILE)) backupContent = fs.readFileSync(QUEUE_FILE, 'utf-8');
function cleanupAndRestore() {
  try {
    if (backupContent !== null) fs.writeFileSync(QUEUE_FILE, backupContent, 'utf-8');
    else if (fs.existsSync(QUEUE_FILE)) fs.unlinkSync(QUEUE_FILE);
  } catch {}
}
process.on('exit', cleanupAndRestore);

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('\n=== T1: enqueueTask 设置 phase=queued, phaseIndex=0 ===');
  await test('enqueue 后 phase 字段正确', async () => {
    T.clearTaskQueue();
    T.setProcessTask(async () => { await wait(5000); }); // 阻塞，不让它真的跑完
    const t = T.enqueueTask(
      { type: 'text', content: 'hello', topic: 'test' },
      { kind: 'text', name: 'hello-test' }
    );
    // enqueueTask 会同步调用 tryDispatch，此时状态可能是 processing（由于 Promise.resolve().then）
    // 但 phaseIndex 仍应在开始阶段
    assert.ok(t.phase === 'queued' || t.phase === 'extracting', 'phase 应为 queued 或 extracting，实际: ' + t.phase);
    assert.strictEqual(t.phaseTotal, 5);
    assert.strictEqual(t.retryable, true, '文本任务应 retryable');
    T.resetProcessTask();
  });

  console.log('\n=== T2: setPhase 推进阶段 ===');
  await test('setPhase 正确更新 index + label', async () => {
    T.clearTaskQueue();
    const t = { id: 'x', status: 'processing', stages: [] };
    T.setPhase(t, 'extracting');
    assert.strictEqual(t.phaseIndex, 1);
    assert.strictEqual(t.phaseLabel, '提取内容');
    T.setPhase(t, 'compiling');
    assert.strictEqual(t.phaseIndex, 3);
    assert.strictEqual(t.phaseLabel, 'AI 编译');
    T.setPhase(t, 'done');
    assert.strictEqual(t.phaseIndex, 4);
  });

  console.log('\n=== T3: 持久化 + 重载 ===');
  await test('scheduleSaveQueue + loadQueue 往返一致', async () => {
    T.clearTaskQueue();
    T.setProcessTask(async (task) => {
      task.status = 'done';
      task.created = [{ path: 'test/foo.md', title: 'Foo' }];
    });
    T.enqueueTask({ type: 'text', content: 'abc', topic: 'test' }, { kind: 'text', name: 'foo' });
    // 等 dispatch + save 完成
    await wait(500);
    assert.ok(fs.existsSync(QUEUE_FILE), '队列文件应存在');
    const raw = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
    assert.ok(Array.isArray(raw) && raw.length === 1);
    assert.strictEqual(raw[0].status, 'done');
    assert.ok(raw[0].created && raw[0].created[0].path === 'test/foo.md');
    T.resetProcessTask();

    // 清空内存队列 → loadQueue 应恢复
    T.clearTaskQueue();
    T.loadQueue();
    const q = T.getTaskQueue();
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].status, 'done');
  });

  console.log('\n=== T4: 进程重启中断标记 ===');
  await test('loadQueue 把 pending/processing 标记为中断错误', async () => {
    T.clearTaskQueue();
    // 手动写一个 pending + 一个 processing 的 fake queue
    const fake = [
      { id: 'p1', status: 'pending', name: 'pending-task', phase: 'queued', submittedAt: '2026-04-17T00:00:00Z' },
      { id: 'p2', status: 'processing', name: 'running-task', phase: 'compiling', submittedAt: '2026-04-17T00:00:00Z' },
      { id: 'p3', status: 'done', name: 'done-task', phase: 'done', finishedAt: '2026-04-17T00:00:00Z' },
    ];
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(fake, null, 2), 'utf-8');
    T.loadQueue();
    const q = T.getTaskQueue();
    assert.strictEqual(q.length, 3);
    assert.strictEqual(q[0].status, 'error');
    assert.strictEqual(q[0].interruptedByRestart, true);
    assert.strictEqual(q[1].status, 'error');
    assert.strictEqual(q[1].interruptedByRestart, true);
    assert.strictEqual(q[2].status, 'done');
    assert.ok(!q[2].interruptedByRestart);
  });

  console.log('\n=== T5: 二进制大 payload 在持久化时被 strip ===');
  await test('pdf 大 content 不落盘，retryable=false', async () => {
    const bigBase64 = 'A'.repeat(50000);
    const task = {
      id: 'big1', status: 'done', name: 'bigpdf', kind: 'pdf', retryable: true,
      payload: { type: 'pdf', content: bigBase64, filename: 'a.pdf' },
    };
    const serialized = T.serializeTaskForPersist(task);
    assert.strictEqual(serialized.payload.content, null);
    assert.strictEqual(serialized.payload._contentStripped, true);
    assert.strictEqual(serialized.retryable, false);
    // 原 task 不应被修改
    assert.strictEqual(task.payload.content, bigBase64);
    assert.strictEqual(task.retryable, true);
  });

  console.log('\n=== T6: 小 URL payload 保留完整 ===');
  await test('url 任务 payload 完整保留', async () => {
    const task = {
      id: 'u1', status: 'done', name: 'url1', kind: 'url', retryable: true,
      payload: { type: 'url', url: 'https://example.com', topic: 'test' },
    };
    const serialized = T.serializeTaskForPersist(task);
    assert.strictEqual(serialized.payload.url, 'https://example.com');
    assert.strictEqual(serialized.retryable, true);
  });

  console.log('\n=== T7: 重试流程（模拟 API 内部逻辑） ===');
  await test('retry 复用原 payload，retryOf + retryCount 正确', async () => {
    T.clearTaskQueue();
    T.setProcessTask(async (task) => { task.status = 'error'; task.message = 'sim fail'; });
    const orig = T.enqueueTask(
      { type: 'url', url: 'https://example.com/a', topic: 'test' },
      { kind: 'url', name: 'example-a' }
    );
    await wait(300);
    assert.strictEqual(orig.status, 'error');

    // 模拟 retry 端点的核心逻辑（直接调用 enqueueTask 复用 payload）
    const retried = T.enqueueTask(orig.payload, {
      kind: orig.kind,
      name: orig.name,
      retryOf: orig.id,
      retryCount: (orig.retryCount || 0) + 1,
    });
    assert.strictEqual(retried.retryOf, orig.id);
    assert.strictEqual(retried.retryCount, 1);
    assert.deepStrictEqual(retried.payload, orig.payload);
    T.resetProcessTask();
  });

  console.log('\n=== T8: pushTask (autotask) 进入 compiling 阶段且 retryable=false ===');
  await test('pushTask 默认 phase=compiling 且不可重试', async () => {
    T.clearTaskQueue();
    const t = T.pushTask('autotask', { name: 'daily-news' });
    assert.strictEqual(t.phase, 'compiling');
    assert.strictEqual(t.phaseIndex, 3);
    assert.strictEqual(t.retryable, false);
    assert.strictEqual(t.status, 'processing');
  });

  console.log('\n=== T9: 并发 10 下的持久化不丢记录 ===');
  await test('20 个并发任务每个状态都正确落盘', async () => {
    T.clearTaskQueue();
    T.setProcessTask(async (task) => {
      // 30% 失败，70% 成功
      await wait(50 + Math.random() * 100);
      if (Math.random() < 0.3) { task.status = 'error'; task.message = 'random fail'; }
      else { task.status = 'done'; task.created = [{ path: 'x/' + task.id + '.md', title: task.id }]; }
    });
    const ids = [];
    for (let i = 0; i < 20; i++) {
      ids.push(T.enqueueTask({ type: 'text', content: 't' + i, topic: 'test' }, { kind: 'text', name: 'n' + i }).id);
    }
    // 等所有完成 + 最后一次 debounced save
    await wait(2000);
    // 内存中所有任务都应是 done/error
    const q = T.getTaskQueue();
    const unfinished = q.filter(t => t.status !== 'done' && t.status !== 'error');
    assert.strictEqual(unfinished.length, 0, '还有未完成任务: ' + unfinished.length);

    // 落盘后再次 load 应一致
    const raw = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
    assert.strictEqual(raw.length, 20);
    const rawStatuses = raw.map(r => r.status).sort();
    const memStatuses = q.map(r => r.status).sort();
    assert.deepStrictEqual(rawStatuses, memStatuses, '磁盘与内存状态不一致');
    T.resetProcessTask();
  });

  console.log('\n=== T10: 持久化文件原子写入（不留半截） ===');
  await test('QUEUE_FILE 总是合法 JSON', async () => {
    T.clearTaskQueue();
    T.setProcessTask(async (task) => { await wait(100); task.status = 'done'; });
    for (let i = 0; i < 5; i++) {
      T.enqueueTask({ type: 'text', content: 'x' + i, topic: 'test' }, { kind: 'text', name: 'a' + i });
    }
    // 中途多次读，必须都是合法 JSON（原子 rename 保证）
    for (let i = 0; i < 10; i++) {
      await wait(80);
      try {
        const raw = fs.readFileSync(QUEUE_FILE, 'utf-8');
        JSON.parse(raw);
      } catch (e) {
        throw new Error('读到半截 JSON: ' + e.message);
      }
    }
    await wait(500);
    T.resetProcessTask();
  });

  console.log('\n─────────────────');
  console.log('PASS', pass, '/ FAIL', fail);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
