// scripts/check-background-scheduler.mjs
//
// 后台宿主定时任务的**独立验证**：不需要编译 Rust、不需要启动应用。
//
// 它把 JSON 一行行写给 `resources/background-host.mjs` 的 stdin，然后读 stdout，
// 断言"到点了会发出一条 schedule.fired 事件"这件事真的发生。这是整条
// 「后台 → 宿主 → 通知」链路里唯一不依赖界面、也不依赖 Tauri 的一半，
// 因此它可以在这里被完整验证。
//
// 用 `.mjs` 而不是 `.ts`：它只用到 Node 内置模块，而把它写成 TS 就要经过
// 一层编译 —— 那会给"验证一个脚本"这件事引入它不需要的构建步骤。

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const hostScript = join(here, '..', 'src-tauri', 'resources', 'background-host.mjs');

const failures = [];
let assertions = 0;

function check(condition, description, detail) {
  assertions += 1;
  if (condition) return;
  failures.push(detail ? `${description}\n      ${detail}` : description);
}

/** 起一个宿主进程，返回一个可以 send / 收集消息的门面 */
function startHost() {
  const child = spawn(process.execPath, [hostScript], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const lines = [];
  const stderr = [];
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim() !== '') {
        try {
          lines.push(JSON.parse(line));
        } catch (error) {
          lines.push({ __unparseable: line, __error: String(error) });
        }
      }
      index = buffer.indexOf('\n');
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));

  let nextId = 1;

  return {
    child,
    lines,
    stderr,
    send(method, params) {
      const id = nextId++;
      const request = { v: 2, id, method };
      if (params !== undefined) request.params = params;
      child.stdin.write(`${JSON.stringify(request)}\n`);
      return id;
    },
    /** 等某条消息出现（按谓词），超时返回 null */
    waitFor(predicate, timeoutMs = 5000) {
      return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
          const found = lines.find(predicate);
          if (found) return resolve(found);
          if (Date.now() > deadline) return resolve(null);
          setTimeout(tick, 20);
        };
        tick();
      });
    },
    waitForId(id, timeoutMs = 5000) {
      return this.waitFor((line) => line.id === id, timeoutMs);
    },
    stop() {
      child.stdin.end();
      return new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(() => child.kill(), 2000);
      });
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // ============================================================
  // 1. 问候必须是第一条，且版本是 2
  // ============================================================
  {
    const host = startHost();
    const greeting = await host.waitFor((line) => typeof line.v === 'number');
    check(greeting !== null, '宿主应当先发一条问候');
    check(greeting?.v === 2, '问候里的协议版本应当是 2（与 Rust 侧一致）', JSON.stringify(greeting));
    check(
      typeof greeting?.runtime === 'string',
      '问候里应当带上运行时标识',
      JSON.stringify(greeting),
    );
    await host.stop();
  }

  // ============================================================
  // 2. 报错的任务定义必须整批拒绝，不能留下"半批生效"
  // ============================================================
  {
    const host = startHost();
    await host.waitFor((line) => typeof line.v === 'number');

    const id = host.send('scheduleSync', {
      schedules: [
        { id: 'good', kind: 'interval', intervalMs: 60000, name: '正常的' },
        { id: 'bad', kind: 'interval' }, // 缺 intervalMs
      ],
    });
    const response = await host.waitForId(id);
    check(
      typeof response?.error === 'string',
      '一条不合法的任务应当让整批同步失败',
      JSON.stringify(response),
    );

    const listId = host.send('scheduleList');
    const list = await host.waitForId(listId);
    check(
      list?.result?.count === 0,
      '失败的同步不该留下任何已生效的任务',
      JSON.stringify(list),
    );
    await host.stop();
  }

  // ============================================================
  // 3. 间隔任务到点会**主动**发出一条事件（不需要任何人来问）
  // ============================================================
  {
    const host = startHost();
    await host.waitFor((line) => typeof line.v === 'number');

    const id = host.send('scheduleSync', {
      schedules: [{ id: 'tick', kind: 'interval', intervalMs: 1000, name: '每秒一次' }],
    });
    const ack = await host.waitForId(id);
    check(ack?.result?.count === 1, '同步应当报告 1 条任务', JSON.stringify(ack));
    check(
      typeof ack?.result?.schedules?.[0]?.nextAt === 'number',
      '同步的返回里应当带上"下一次什么时候响"',
      JSON.stringify(ack),
    );

    const fired = await host.waitFor(
      (line) => line.event === 'schedule.fired' && line.subject === 'tick',
      5000,
    );
    check(fired !== null, '间隔任务到点后应当主动发出一条 schedule.fired 事件');
    check(fired?.id === undefined, '事件里不该有 id（有 id 的才是响应）', JSON.stringify(fired));
    check(fired?.v === 2, '事件也要带协议版本', JSON.stringify(fired));
    check(
      typeof fired?.data?.scheduledAt === 'number' && typeof fired?.data?.firedAt === 'number',
      '事件里应当同时有"计划时刻"与"实际时刻"',
      JSON.stringify(fired),
    );
    check(
      fired?.data?.fireCount === 1,
      '第一次触发的 fireCount 应当是 1',
      JSON.stringify(fired?.data),
    );

    await host.stop();
  }

  // ============================================================
  // 4. 立即触发：链路与定时器完全相同，但不改变下一次的时刻
  // ============================================================
  {
    const host = startHost();
    await host.waitFor((line) => typeof line.v === 'number');

    await host.waitForId(
      host.send('scheduleSync', {
        schedules: [{ id: 'manual', kind: 'daily', minuteOfDay: 0, name: '每天零点' }],
      }),
    );

    const before = await host.waitForId(host.send('scheduleList'));
    const nextBefore = before?.result?.schedules?.[0]?.nextAt;

    const runId = host.send('scheduleRunNow', { id: 'manual' });
    const fired = await host.waitFor(
      (line) => line.event === 'schedule.fired' && line.subject === 'manual',
      3000,
    );
    check(fired !== null, '立即触发应当产生一条事件');
    check(
      fired?.data?.reason === 'manual',
      '立即触发的事件里应当标明来源是 manual',
      JSON.stringify(fired?.data),
    );

    const after = await host.waitForId(host.send('scheduleList'));
    check(
      after?.result?.schedules?.[0]?.nextAt === nextBefore,
      '立即触发不该改变"下一次什么时候响"',
      `${nextBefore} -> ${after?.result?.schedules?.[0]?.nextAt}`,
    );

    const runResponse = await host.waitForId(runId);
    check(
      runResponse?.result?.fireCount === 1,
      '立即触发的响应里应当带上触发次数',
      JSON.stringify(runResponse),
    );

    await host.stop();
  }

  // ============================================================
  // 5. 全量同步会替换掉不在列表里的任务（不是增量叠加）
  // ============================================================
  {
    const host = startHost();
    await host.waitFor((line) => typeof line.v === 'number');

    await host.waitForId(
      host.send('scheduleSync', {
        schedules: [
          { id: 'a', kind: 'interval', intervalMs: 60000 },
          { id: 'b', kind: 'interval', intervalMs: 60000 },
        ],
      }),
    );

    const second = await host.waitForId(
      host.send('scheduleSync', { schedules: [{ id: 'b', kind: 'interval', intervalMs: 60000 }] }),
    );
    check(
      second?.result?.count === 1 && second?.result?.schedules?.[0]?.id === 'b',
      '同步之后只剩列表里的任务',
      JSON.stringify(second?.result),
    );

    await host.stop();
  }

  // ============================================================
  // 6. 上限保护：低于最小间隔的请求会被抬到下限，而不是被接受
  // ============================================================
  {
    const host = startHost();
    await host.waitFor((line) => typeof line.v === 'number');

    const response = await host.waitForId(
      host.send('scheduleSync', {
        schedules: [{ id: 'toofast', kind: 'interval', intervalMs: 1 }],
      }),
    );
    check(
      response?.result?.schedules?.[0]?.intervalMs === 1000,
      '最小间隔应当被抬到 1000 毫秒（防止写错的任务把 CPU 占满）',
      JSON.stringify(response?.result?.schedules?.[0]),
    );

    await host.stop();
  }

  // ============================================================
  // 7. 未知任务 id 的立即触发必须报错，而不是静默成功
  // ============================================================
  {
    const host = startHost();
    await host.waitFor((line) => typeof line.v === 'number');

    const response = await host.waitForId(host.send('scheduleRunNow', { id: 'nope' }));
    check(
      typeof response?.error === 'string' && response.error.includes('nope'),
      '触发一个不存在的任务必须报错并指出是哪个 id',
      JSON.stringify(response),
    );

    await host.stop();
  }

  // ============================================================
  // 8. once 任务触发一次之后不再等待（不会重复提醒）
  // ============================================================
  {
    const host = startHost();
    await host.waitFor((line) => typeof line.v === 'number');

    const soon = Date.now() + 300;
    await host.waitForId(
      host.send('scheduleSync', {
        schedules: [{ id: 'once', kind: 'once', at: soon, name: '只响一次' }],
      }),
    );

    const fired = await host.waitFor(
      (line) => line.event === 'schedule.fired' && line.subject === 'once',
      3000,
    );
    check(fired !== null, 'once 任务到点应当触发');

    await sleep(600);
    const list = await host.waitForId(host.send('scheduleList'));
    check(
      list?.result?.schedules?.[0]?.nextAt === null,
      'once 任务触发之后不该再有下一次',
      JSON.stringify(list?.result?.schedules?.[0]),
    );

    const fires = host.lines.filter(
      (line) => line.event === 'schedule.fired' && line.subject === 'once',
    );
    check(fires.length === 1, 'once 任务只应当触发一次', `实际触发 ${fires.length} 次`);

    await host.stop();
  }

  // ============================================================
  // 9. 状态里能看到定时任务的规模（而不是永远报 0）
  // ============================================================
  {
    const host = startHost();
    await host.waitFor((line) => typeof line.v === 'number');

    await host.waitForId(
      host.send('scheduleSync', {
        schedules: [
          { id: 's1', kind: 'interval', intervalMs: 60000 },
          { id: 's2', kind: 'interval', intervalMs: 90000 },
        ],
      }),
    );

    const status = await host.waitForId(host.send('status'));
    check(
      status?.result?.schedules === 2,
      'status 里应当报告当前的定时任务条数',
      JSON.stringify(status?.result),
    );
    check(
      status?.result?.protocolVersion === 2,
      'status 里报告的协议版本应当是 2',
      JSON.stringify(status?.result),
    );

    await host.stop();
  }
}

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(`\n后台定时任务检查未通过：${failures.length} 项失败（共 ${assertions} 项断言）\n`);
      for (const failure of failures) console.error(`  × ${failure}`);
      process.exit(1);
    }
    console.log(`后台定时任务检查通过：${assertions} 项断言`);
  })
  .catch((error) => {
    console.error(`后台定时任务检查自身出错：${error?.stack ?? error}`);
    process.exit(1);
  });
