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

  console.log('\n=== T11: 损坏 tasks.json 自动备份，不被空队列覆盖 ===');
  await test('loadQueue 遇到坏 JSON 时 rename 为 .corrupt-*', async () => {
    fs.writeFileSync(QUEUE_FILE, '{not-valid-json', 'utf-8');
    T.clearTaskQueue();
    T.loadQueue();
    assert.strictEqual(T.getTaskQueue().length, 0);
    // 原文件应被 rename，不再是 QUEUE_FILE
    assert.ok(!fs.existsSync(QUEUE_FILE), '损坏文件应已被 rename');
    const dir = path.dirname(QUEUE_FILE);
    const backups = fs.readdirSync(dir).filter(f => f.includes('.corrupt-'));
    assert.ok(backups.length > 0, '应生成 .corrupt-* 备份文件');
    // 清理
    backups.forEach(f => fs.unlinkSync(path.join(dir, f)));
  });

  console.log('\n=== T12: 文本 payload 超过 32KB 在持久化时 strip ===');
  await test('大文本 payload 被 strip，retryable=false', async () => {
    const bigText = 'a'.repeat(50 * 1024);
    const task = {
      id: 'bt1', status: 'done', name: 'bigtext', kind: 'text', retryable: true,
      payload: { type: 'text', content: bigText, topic: 'x' },
    };
    const s = T.serializeTaskForPersist(task);
    assert.strictEqual(s.payload.content, null);
    assert.strictEqual(s.payload._contentStripped, true);
    assert.ok(s.payload._strippedReason && s.payload._strippedReason.startsWith('oversize:'));
    assert.strictEqual(s.retryable, false);
    // 原对象未被破坏
    assert.strictEqual(task.payload.content, bigText);
  });

  console.log('\n=== T13: 持久化 JSON 无 pretty-print（紧凑） ===');
  await test('落盘 JSON 没有多余空白', async () => {
    T.clearTaskQueue();
    T.setProcessTask(async (task) => { task.status = 'done'; });
    T.enqueueTask({ type: 'text', content: 'abc', topic: 'test' }, { kind: 'text', name: 'a' });
    await wait(500);
    const raw = fs.readFileSync(QUEUE_FILE, 'utf-8');
    // pretty-print 会有 "\n  " 这种缩进；紧凑格式没有
    assert.ok(!raw.includes('\n  '), 'JSON 应为紧凑格式，不要 pretty-print');
    T.resetProcessTask();
  });

  console.log('\n=== T14: error 任务 phase/status 一致（phaseIndex 锁到终态） ===');
  await test('失败任务 phaseIndex 不停在中间', async () => {
    T.clearTaskQueue();
    T.setProcessTask(async (task) => {
      // 模拟在 extracting 阶段失败：phaseIndex=1，status=error
      task.phase = 'extracting';
      task.phaseIndex = 1;
      task.status = 'error';
      task.message = 'extract failed';
    });
    const t = T.enqueueTask({ type: 'url', url: 'https://x.com/a', topic: 'x' }, { kind: 'url', name: 'a' });
    await wait(300);
    // .finally 应把 phaseIndex 推到 PHASE_TOTAL-1，phase/phaseLabel 改为 error/失败
    assert.strictEqual(t.phase, 'error');
    assert.strictEqual(t.phaseIndex, T.PHASE_TOTAL - 1);
    assert.strictEqual(t.phaseLabel, '失败');
    T.resetProcessTask();
  });

  console.log('\n=== T15: 中断恢复状态同步落盘（不等 debounce） ===');
  await test('interruptedByRestart 立即 flush', async () => {
    // 准备一个 pending 任务的 snapshot
    const fake = [{
      id: 'int1', status: 'pending', name: 'a', phase: 'queued',
      submittedAt: '2026-04-17T00:00:00Z',
    }];
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(fake), 'utf-8');
    T.clearTaskQueue();
    T.loadQueue();
    // loadQueue 里应同步 flush，不等 debounce
    const disk = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
    assert.strictEqual(disk[0].status, 'error');
    assert.strictEqual(disk[0].interruptedByRestart, true);
  });

  console.log('\n=== T16: 重试链：retry of retry，retryOf 指向链头 ===');
  await test('第 N 次重试仍指向原始任务 id', async () => {
    T.clearTaskQueue();
    T.setProcessTask(async (task) => { task.status = 'error'; task.message = 'sim fail'; });
    const orig = T.enqueueTask(
      { type: 'url', url: 'https://example.com/chain', topic: 'test' },
      { kind: 'url', name: 'chain-orig' }
    );
    await wait(200);
    assert.strictEqual(orig.status, 'error');

    // 第 1 次重试：模拟 /api/ingest/retry/:id 端点逻辑
    const retry1 = T.enqueueTask(orig.payload, {
      kind: orig.kind, name: orig.name,
      retryOf: orig.retryOf || orig.id,
      retryCount: (orig.retryCount || 0) + 1,
    });
    await wait(200);
    assert.strictEqual(retry1.retryOf, orig.id);
    assert.strictEqual(retry1.retryCount, 1);
    assert.strictEqual(retry1.status, 'error');

    // 第 2 次重试：基于 retry1 再重试，retryOf 仍应是链头 orig.id
    const retry2 = T.enqueueTask(retry1.payload, {
      kind: retry1.kind, name: retry1.name,
      retryOf: retry1.retryOf || retry1.id,   // 关键：从 retry1.retryOf 继承
      retryCount: (retry1.retryCount || 0) + 1,
    });
    assert.strictEqual(retry2.retryOf, orig.id, 'retry2.retryOf 必须指向链头 orig.id');
    assert.strictEqual(retry2.retryCount, 2);
    T.resetProcessTask();
  });

  console.log('\n=== T17: 被 strip 的 payload 重启后不应 retryable ===');
  await test('serialize 后再 load，retryable=false 且 payload 标记 stripped', async () => {
    T.clearTaskQueue();
    // 手写一个已完成但 payload 过大的任务
    const bigContent = 'Z'.repeat(40 * 1024);
    const fake = [{
      id: 'strip1', status: 'error', name: 'big', kind: 'text',
      phase: 'error', phaseIndex: T.PHASE_TOTAL - 1,
      retryable: true,  // 假装之前是 true
      payload: { type: 'text', content: bigContent, topic: 'x' },
      submittedAt: '2026-04-17T00:00:00Z',
      finishedAt: '2026-04-17T00:01:00Z',
      message: 'some error',
    }];
    // 模拟持久化路径：serializeTaskForPersist 应剥离大 payload
    const serialized = fake.map(T.serializeTaskForPersist);
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(serialized), 'utf-8');
    T.clearTaskQueue();
    T.loadQueue();
    const q = T.getTaskQueue();
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].retryable, false, '重启后 stripped 任务不应 retryable');
    assert.strictEqual(q[0].payload._contentStripped, true);
    // 后续 /api/ingest/retry 端点会检查 payload._contentStripped → 拒绝
  });

  console.log('\n=== T18: 空数组 tasks.json 正常 load ===');
  await test('空数组不被当作损坏', async () => {
    fs.writeFileSync(QUEUE_FILE, '[]', 'utf-8');
    T.clearTaskQueue();
    T.loadQueue();
    assert.strictEqual(T.getTaskQueue().length, 0);
    // 文件应保留（不应被 rename 成 corrupt）
    assert.ok(fs.existsSync(QUEUE_FILE));
  });

  console.log('\n=== T19: 非数组 JSON（如 object）视为损坏 ===');
  await test('对象形式 JSON 触发 corrupt 备份', async () => {
    fs.writeFileSync(QUEUE_FILE, '{"not":"an array"}', 'utf-8');
    T.clearTaskQueue();
    const dir = path.dirname(QUEUE_FILE);
    const before = fs.readdirSync(dir).filter(f => f.includes('.corrupt-'));
    T.loadQueue();
    assert.strictEqual(T.getTaskQueue().length, 0);
    const after = fs.readdirSync(dir).filter(f => f.includes('.corrupt-'));
    assert.ok(after.length > before.length, '非数组 JSON 应触发 corrupt 备份');
    // 清理
    after.forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch {} });
  });

  console.log('\n=== T20: 持续高频 enqueue 下 MAX_WAIT 强制 flush ===');
  await test('持续 dirty 超过 MAX_WAIT 后落盘可被外部读取', async () => {
    T.clearTaskQueue();
    if (fs.existsSync(QUEUE_FILE)) fs.unlinkSync(QUEUE_FILE);
    T.setProcessTask(async (task) => { await wait(50); task.status = 'done'; });
    // 持续 2.5 秒内不断 enqueue，每次都重置 debounce，但 MAX_WAIT=2000ms 应强制 flush
    const start = Date.now();
    let i = 0;
    while (Date.now() - start < 2500) {
      T.enqueueTask({ type: 'text', content: 'burst' + i, topic: 't' }, { kind: 'text', name: 'b' + i });
      i++;
      await wait(100);  // 100ms < debounce 300ms，理论上 debounce 不会触发
    }
    // 此时应已有至少一次 MAX_WAIT 强制 flush 了
    assert.ok(fs.existsSync(QUEUE_FILE), 'QUEUE_FILE 应已存在（MAX_WAIT 强制 flush）');
    const raw = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
    assert.ok(raw.length > 0, '应有至少 1 个任务落盘');
    // 等 debounce 彻底把剩余任务 flush 掉
    await wait(800);
    T.resetProcessTask();
  });

  console.log('\n=== T21: 并发重试同一任务的幂等逻辑（模拟端点锁） ===');
  await test('retryingTaskId 存在且对应任务未终结时，第二次重试应复用而非新建', async () => {
    T.clearTaskQueue();
    // 阻塞型 processTask：让重试任务一直 processing
    T.setProcessTask(async () => { await wait(10000); });
    const orig = {
      id: 'idem1', status: 'error', name: 'idem', kind: 'text',
      phase: 'error', phaseIndex: T.PHASE_TOTAL - 1,
      retryable: true,
      payload: { type: 'text', content: 'small', topic: 'x' },
      submittedAt: '2026-04-17T00:00:00Z',
    };
    T.getTaskQueue().push(orig);

    // 第 1 次重试
    const retry1 = T.enqueueTask(orig.payload, {
      kind: orig.kind, name: orig.name,
      retryOf: orig.id, retryCount: 1,
    });
    orig.retryingTaskId = retry1.id;  // 端点会设这个
    await wait(20);
    assert.ok(retry1.status === 'pending' || retry1.status === 'processing');

    // 第 2 次重试（模拟双击）：端点会检查 retryingTaskId，并复用
    const existing = T.getTaskQueue().find(t => t.id === orig.retryingTaskId);
    assert.ok(existing, 'retryingTaskId 指向的任务必须存在');
    assert.ok(existing.status === 'pending' || existing.status === 'processing',
      '未终结的重试应阻止新建：' + existing.status);
    // 端点会直接 return existing.id，而不再 enqueue；这里验证队列没被污染
    const retriesOfOrig = T.getTaskQueue().filter(t => t.retryOf === orig.id);
    assert.strictEqual(retriesOfOrig.length, 1, '只应有 1 个重试任务，实际: ' + retriesOfOrig.length);
    T.resetProcessTask();
  });

  console.log('\n=== T22: 重启后 retryOf/retryCount 持久化 ===');
  await test('retryOf + retryCount 经过落盘/重载仍保留', async () => {
    T.clearTaskQueue();
    T.setProcessTask(async (task) => { task.status = 'done'; });
    const orig = T.enqueueTask(
      { type: 'text', content: 'persist-retry', topic: 't' },
      { kind: 'text', name: 'orig', retryOf: 'original-chain-id', retryCount: 3 }
    );
    await wait(400);
    assert.strictEqual(orig.retryOf, 'original-chain-id');
    assert.strictEqual(orig.retryCount, 3);

    // 重载
    T.clearTaskQueue();
    T.loadQueue();
    const q = T.getTaskQueue();
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].retryOf, 'original-chain-id');
    assert.strictEqual(q[0].retryCount, 3);
    T.resetProcessTask();
  });

  console.log('\n─────────────────');
  console.log('PASS', pass, '/ FAIL', fail);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
