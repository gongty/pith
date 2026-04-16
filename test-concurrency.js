// 投喂任务并发架构测试套件
// 用法：node test-concurrency.js
// T1 会 fork 一个子进程重跑自身（WIKI_INGEST_CONCURRENCY=3）
// T6-T8 会 spawn 一个独立 server 子进程 (PORT=3999) 做端到端请求

'use strict';

const path = require('path');
const { spawn, fork } = require('child_process');
const http = require('http');

const SERVER_PATH = path.join(__dirname, 'server.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let PASSED = 0;
let FAILED = 0;
const FAILURES = [];

function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`Assertion failed: ${msg}  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}
async function run(name, fn) {
  process.stdout.write(`[TEST] ${name} ... `);
  try {
    await fn();
    PASSED++;
    console.log('PASS');
  } catch (e) {
    FAILED++;
    FAILURES.push({ name, error: e });
    console.log('FAIL');
    console.log('       ' + (e && e.stack || e));
  }
}

// ── T1：并发上限严格生效（通过子进程 fork 自身重跑）──
async function runT1ViaFork() {
  return new Promise((resolve) => {
    const child = fork(__filename, ['--t1-worker'], {
      env: { ...process.env, WIKI_INGEST_CONCURRENCY: '3', WIKI_SKIP_T1_FORK: '1' },
      stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); process.stdout.write(d); });
    child.stderr.on('data', d => { process.stderr.write(d); });
    child.on('exit', (code) => {
      if (code === 0) { PASSED++; }
      else { FAILED++; FAILURES.push({ name: 'T1 (subprocess)', error: new Error('exit code ' + code) }); }
      resolve();
    });
  });
}

async function t1Worker() {
  const srv = require(SERVER_PATH);
  const { setProcessTask, getActiveCount, getTaskQueue, enqueueTask, clearTaskQueue, INGEST_CONCURRENCY } = srv.__test;
  console.log('[TEST] T1 concurrency=3 (subprocess, WIKI_INGEST_CONCURRENCY=' + INGEST_CONCURRENCY + ') ...');
  assertEq(INGEST_CONCURRENCY, 3, 'env 未生效');
  clearTaskQueue();

  setProcessTask(async (task) => {
    await sleep(500);
    task.status = 'done';
    task.finishedAt = new Date().toISOString();
  });

  for (let i = 0; i < 20; i++) {
    enqueueTask({ type: 'text', content: 'x' + i, topic: 'test' }, { kind: 'text', name: 'item-' + i });
  }

  await sleep(100);
  const active = getActiveCount();
  const queue = getTaskQueue();
  const pendingN = queue.filter(t => t.status === 'pending').length;
  const processingN = queue.filter(t => t.status === 'processing').length;
  assertEq(active, 3, `activeCount 应该 === 3, 实际=${active}`);
  assertEq(processingN, 3, `processing 应该 === 3, 实际=${processingN}`);
  assertEq(pendingN, 17, `pending 应该 === 17, 实际=${pendingN}`);

  // 等全部完成（单批 500ms，3 并发 × 7 轮 = ~3.5s，留足富余）
  await sleep(5000);
  const q2 = getTaskQueue();
  const stillProcessing = q2.filter(t => t.status === 'processing').length;
  const doneCount = q2.filter(t => t.status === 'done').length;
  assertEq(getActiveCount(), 0, 'activeCount 应归 0');
  assertEq(stillProcessing, 0, '应无遗留 processing');
  assert(doneCount >= 20, 'done 数应 >= 20, 实际=' + doneCount);
  console.log('[TEST] T1 PASS');
  process.exit(0);
}

// ── T2-T5, T9：单进程 require（默认 concurrency=10）──
async function unitTests() {
  const srv = require(SERVER_PATH);
  const { setProcessTask, resetProcessTask, getActiveCount, getTaskQueue, clearTaskQueue,
          enqueueTask, pushTask, getBatchSummary, findLatestBatchId, externalStatus,
          genTaskId, INGEST_CONCURRENCY } = srv.__test;

  // T2: 两个 batch 同时跑互不干扰
  await run('T2 两个 batch 同时跑互不干扰', async () => {
    clearTaskQueue();
    resetProcessTask();
    setProcessTask(async (task) => {
      await sleep(200);
      task.status = 'done';
      task.finishedAt = new Date().toISOString();
    });
    const batchA = 'batch-A';
    const batchB = 'batch-B';
    for (let i = 0; i < 5; i++) {
      enqueueTask({ type: 'text', content: 'A' + i }, { kind: 'text', name: 'A-' + i, batchId: batchA, batchIndex: i });
    }
    for (let i = 0; i < 5; i++) {
      enqueueTask({ type: 'text', content: 'B' + i }, { kind: 'text', name: 'B-' + i, batchId: batchB, batchIndex: i });
    }
    // findLatestBatchId 返回 B（后入）
    assertEq(findLatestBatchId(), batchB, 'findLatestBatchId 应返回 B');
    const sA = getBatchSummary(batchA);
    const sB = getBatchSummary(batchB);
    assert(sA && sA.total === 5, 'batch A 应有 5 个 item');
    assert(sB && sB.total === 5, 'batch B 应有 5 个 item');
    // 手动标记 A 的第 0 个 error，确认 B 不受影响
    const q = getTaskQueue();
    const firstA = q.find(t => t.batchId === batchA);
    firstA.status = 'error';
    firstA.message = 'injected failure';
    firstA.finishedAt = new Date().toISOString();
    const sA2 = getBatchSummary(batchA);
    assert(sA2.failed >= 1, 'batch A 应记录至少 1 个 failed');
    const sB2 = getBatchSummary(batchB);
    assertEq(sB2.failed, 0, 'batch B failed 应为 0（A 的错误不应污染 B）');
    await sleep(2000);
    const sA3 = getBatchSummary(batchA);
    const sB3 = getBatchSummary(batchB);
    assertEq(sA3.status, 'done', 'batch A 应完成');
    assertEq(sB3.status, 'done', 'batch B 应完成');
    assertEq(sB3.failed, 0, 'batch B 应无失败');
  });

  // T3: worker 异常不死锁
  await run('T3 worker 异常不死锁', async () => {
    clearTaskQueue();
    resetProcessTask();
    let idx = 0;
    setProcessTask(async (task) => {
      const mode = idx++ % 10;
      await sleep(30 + Math.random() * 40);
      if (mode < 3) {
        // 30% synchronous throw after await
        throw new Error('sync-ish exception');
      } else if (mode < 6) {
        // 30% async rejection
        return Promise.reject(new Error('async rejection'));
      } else {
        task.status = 'done';
        task.finishedAt = new Date().toISOString();
      }
    });
    for (let i = 0; i < 50; i++) {
      enqueueTask({ type: 'text', content: 'c' + i }, { kind: 'text', name: 'item-' + i });
    }
    // 等完成（默认 10 并发，50 个 × ~50ms = ~250ms 平均，多给时间）
    await sleep(3000);
    assertEq(getActiveCount(), 0, 'activeCount 应归 0（死锁检测）');
    const q = getTaskQueue();
    const stillProcessing = q.filter(t => t.status === 'processing').length;
    const stillPending = q.filter(t => t.status === 'pending').length;
    assertEq(stillProcessing, 0, '不应有遗留 processing');
    assertEq(stillPending, 0, '不应有遗留 pending');
    // 每个任务都应有 finishedAt
    const missing = q.filter(t => !t.finishedAt);
    assertEq(missing.length, 0, '所有任务应有 finishedAt，缺失数=' + missing.length);
  });

  // T4: id 无碰撞
  await run('T4 id 无碰撞（1ms 内 100 个）', async () => {
    clearTaskQueue();
    resetProcessTask();
    // 把 processTask mock 成一个不会消耗 queue 的 no-op（让 task 留在队列里）
    setProcessTask(async (task) => { await sleep(50); task.status = 'done'; task.finishedAt = new Date().toISOString(); });
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      const t = enqueueTask({ type: 'text' }, { kind: 'text', name: 'i' + i });
      ids.add(t.id);
    }
    assertEq(ids.size, 100, 'id 应全唯一，实际 size=' + ids.size);
    await sleep(800); // 让 queue 排空
  });

  // T5: queue cap 行为（pending/processing 永不被剔除）
  await run('T5 queue cap 行为', async () => {
    clearTaskQueue();
    resetProcessTask();
    // mock：永远不完成（让所有任务卡在 processing/pending）
    let blockers = [];
    setProcessTask(async (task) => {
      return new Promise((resolve) => {
        blockers.push(() => {
          task.status = 'done';
          task.finishedAt = new Date().toISOString();
          resolve();
        });
      });
    });
    // 先入队 10 个 pending/processing（肯定 <200）
    for (let i = 0; i < 10; i++) {
      enqueueTask({ type: 'text' }, { kind: 'text', name: 'live-' + i });
    }
    await sleep(50); // 10 个会变为 processing（activeCount 达 10）
    // 再手动往 taskQueue 塞 250 个 done 历史（模拟大量历史）
    const srv2 = require(SERVER_PATH);
    const q = srv2.__test.getTaskQueue();
    for (let i = 0; i < 250; i++) {
      q.push({
        id: genTaskId(), kind: 'text', type: 'text', status: 'done',
        name: 'hist-' + i, submittedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        batchId: null, message: 'done', stages: [], created: null, payload: null,
      });
    }
    // 再 enqueue 1 个新 pending，触发 _trimQueue
    enqueueTask({ type: 'text' }, { kind: 'text', name: 'new-after-trim' });
    const q2 = srv2.__test.getTaskQueue();
    assert(q2.length <= 200, `trim 后长度应 <=200, 实际 ${q2.length}`);
    const liveAfter = q2.filter(t => t.status === 'processing' || t.status === 'pending').length;
    // 原 10 个 processing + 刚入的 1 个 pending (或已变 processing) = 11
    assert(liveAfter >= 11, `pending/processing 应不被剔除，实际 live=${liveAfter}`);
    const hasNew = q2.some(t => t.name === 'new-after-trim');
    assert(hasNew, '新 enqueue 的 task 应该存在');
    // 释放 blockers
    blockers.forEach(fn => fn());
    await sleep(200);
  });

  // T9: autotask / precipitate 不受影响
  await run('T9 pushTask 不走并发池', async () => {
    clearTaskQueue();
    resetProcessTask();
    // mock：processTask 异常能检测（不应被 pushTask 触发）
    let called = false;
    setProcessTask(async (task) => { called = true; task.status = 'done'; task.finishedAt = new Date().toISOString(); });
    const beforeActive = getActiveCount();
    const t = pushTask('autotask');
    assertEq(t.status, 'processing', 'pushTask 应立即为 processing');
    assertEq(getActiveCount(), beforeActive, 'pushTask 不应增加 activeCount');
    await sleep(100);
    assertEq(called, false, 'pushTask 不应触发 processTask mock');
  });

  resetProcessTask();
}

// ── T6-T8：子进程 server（PORT=3999）做端到端 ──
function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(b) }); }
        catch (e) { reject(new Error('JSON parse: ' + b.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}
function postJSON(url, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(payload);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(b) }); }
        catch (e) { reject(new Error('JSON parse: ' + b.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// 子 server 需要 mock processTask。启动一个包装脚本。
const WRAPPER_CODE = `
  const srv = require(${JSON.stringify(SERVER_PATH)});
  srv.__test.setProcessTask(async (task) => {
    await new Promise(r => setTimeout(r, 300));
    task.status = 'done';
    task.finishedAt = new Date().toISOString();
    task.created = [{ path: 'test/' + task.name + '.md' }];
  });
  srv.server.listen(${3999}, () => console.log('TEST_SERVER_READY'));
`;

async function startChildServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', WRAPPER_CODE], {
      env: { ...process.env, PORT: '3999', WIKI_SKIP_T1_FORK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => {
      out += d.toString();
      if (out.includes('TEST_SERVER_READY')) resolve(child);
    });
    child.stderr.on('data', d => { /* swallow stderr noise */ });
    setTimeout(() => reject(new Error('server start timeout; out=' + out)), 8000);
  });
}

async function endpointTests() {
  const srv = await startChildServer();
  const BASE = 'http://127.0.0.1:3999';
  try {
    // T6: /api/ingest/overview
    await run('T6 /api/ingest/overview contract', async () => {
      // 先 POST 一个 batch
      const postRes = await postJSON(BASE + '/api/ingest', {
        items: [
          { type: 'text', content: 'a', topic: 'test' },
          { type: 'text', content: 'b', topic: 'test' },
          { type: 'text', content: 'c', topic: 'test' },
        ],
      });
      assertEq(postRes.status, 200, 'POST 应 200');
      assert(postRes.body.batchId, 'POST 应返回 batchId');
      const batchId = postRes.body.batchId;
      // 立即查 overview
      await sleep(50);
      const ov1 = await getJSON(BASE + '/api/ingest/overview');
      assertEq(ov1.status, 200, 'overview 应 200');
      assert(Array.isArray(ov1.body.running), 'running 应数组');
      assert(Array.isArray(ov1.body.queued), 'queued 应数组');
      assert(Array.isArray(ov1.body.recent), 'recent 应数组');
      assertEq(typeof ov1.body.hasActivity, 'boolean', 'hasActivity 应布尔');
      // running/queued 项应有指定字段
      const allLive = [...ov1.body.running, ...ov1.body.queued];
      if (allLive.length) {
        const x = allLive[0];
        assert(x.id && x.name, 'live 项应有 id/name');
        assert(x.status === 'running' || x.status === 'queued', 'status 应为 running 或 queued');
      }
      // batch 在 processing 时应非 null
      assert(ov1.body.batch, 'processing 时 batch 应非 null');
      assertEq(ov1.body.batch.id, batchId, 'batch id 应匹配');
      // 等全部完成
      await sleep(2000);
      const ov2 = await getJSON(BASE + '/api/ingest/overview');
      assertEq(ov2.body.running.length, 0, '完成后应无 running');
      assertEq(ov2.body.queued.length, 0, '完成后应无 queued');
      assertEq(ov2.body.batch, null, '完成后 batch 应为 null');
      // recent 按 finishedAt desc
      if (ov2.body.recent.length >= 2) {
        const t0 = new Date(ov2.body.recent[0].finishedAt).getTime();
        const t1 = new Date(ov2.body.recent[1].finishedAt).getTime();
        assert(t0 >= t1, 'recent 应按 finishedAt desc 排序');
      }
    });

    // T7: /api/ingest/batch/status
    await run('T7 /api/ingest/batch/status 兼容', async () => {
      const postRes = await postJSON(BASE + '/api/ingest', {
        items: [
          { type: 'text', content: 'x', topic: 'test' },
          { type: 'text', content: 'y', topic: 'test' },
        ],
      });
      const batchId = postRes.body.batchId;
      await sleep(50);
      const r1 = await getJSON(BASE + '/api/ingest/batch/status?id=' + batchId);
      assertEq(r1.status, 200, 'batch status 应 200');
      const s = r1.body;
      assert(typeof s.total === 'number', 'total 应 number');
      assert(typeof s.completed === 'number', 'completed 应 number');
      assert(typeof s.failed === 'number', 'failed 应 number');
      assert(typeof s.status === 'string', 'status 应 string');
      assert(Array.isArray(s.files), 'files 应数组');
      assertEq(s.total, 2, 'total 应 === 2');
      // 无 id 参数 → 返回最新 batch
      const r2 = await getJSON(BASE + '/api/ingest/batch/status');
      assert(r2.body.id === batchId || r2.body.status === 'processing' || r2.body.status === 'done',
        '无 id 参数应返回最新 batch 或 idle');
      await sleep(1500); // 等完成
    });

    // T8: /api/ingest/active 前端契约（externalStatus 映射）
    await run('T8 /api/ingest/active externalStatus 映射', async () => {
      const postRes = await postJSON(BASE + '/api/ingest', {
        type: 'text', content: 'z', topic: 'test',
      });
      const taskId = postRes.body.taskId;
      await sleep(50);
      const r1 = await getJSON(BASE + '/api/ingest/active');
      const item = r1.body.items.find(x => x.id === taskId);
      assert(item, '应能在 active 里找到刚 POST 的任务');
      assertEq(item.status, 'compiling', 'status 应映射为 compiling');
      // 等完成
      await sleep(1000);
      const r2 = await getJSON(BASE + '/api/ingest/active');
      const item2 = r2.body.items.find(x => x.id === taskId);
      // 30s 内仍可见
      assert(item2, '完成 30s 内仍应可见');
      assertEq(item2.status, 'done', '完成后 status === done');
    });
  } finally {
    srv.kill('SIGTERM');
    await sleep(200);
  }
}

// ── 入口 ──
async function main() {
  // T1 worker 模式（被 fork 时进入）
  if (process.argv.includes('--t1-worker')) {
    try {
      await t1Worker();
    } catch (e) {
      console.error('[T1 WORKER FAIL]', e && e.stack || e);
      process.exit(1);
    }
    return;
  }

  console.log('=== 投喂任务并发架构测试套件 ===\n');

  // T1 via fork
  process.stdout.write('[TEST] T1 并发上限严格生效（fork 子进程）... ');
  await runT1ViaFork();

  await unitTests();
  await endpointTests();

  console.log('\n=== 结果：' + PASSED + ' passed, ' + FAILED + ' failed ===');
  if (FAILED > 0) {
    console.log('\n失败详情：');
    FAILURES.forEach(f => {
      console.log('  - ' + f.name + ': ' + (f.error && f.error.message || f.error));
    });
    process.exit(1);
  }
  console.log('All tests passed (' + PASSED + '/' + PASSED + ')');
  process.exit(0);
}

main().catch(e => {
  console.error('fatal:', e);
  process.exit(1);
});
