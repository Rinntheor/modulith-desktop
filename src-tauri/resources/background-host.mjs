// background-host.mjs
//
// 后台宿主：与界面无关的插件运行环境。
//
// ============================================================
// 为什么是独立的 Node 进程
// ============================================================
//
// 应用要有"在窗口之外继续工作"的能力（后台插件、使用情况监测）。这些能力要求
// **进程不随窗口关闭而结束**，而界面插件跑在主窗口的 WebView 里 —— 那个环境会被
// 降级（内存目标等级设为 Low）、会被隐藏、脚本会被浏览器冻结。
// 把"长期在后台跑着的事"托付给它，等于托付给一个随时可能被挂起的执行环境。
//
// 选 Node 而不是"再开一个隐藏 WebView"：隐藏 WebView 依然是一整套浏览器进程
// （实测 6~8 个、几百 MB），而这是一个进程、且能在不需要时被完全关掉。
//
// ============================================================
// 协议（与 src-tauri/src/modules/desktop/background/protocol.rs 一一对应）
// ============================================================
//
//   · stdin/stdout 上**每行一个 JSON**；stderr 留给日志（不做协议用）。
//   · 启动后第一件事是打印一行**问候**：`{"v":1,"runtime":"node/…"}`。
//     宿主会先读它再投入使用，因此协议版本错配在启动那一刻就暴露，
//     而不是在某个具体调用上以一个奇怪的字段缺失暴露。
//   · 每条请求 `{v,id,method,params?}`，每条响应 `{v,id,result?|error?}`。
//   · 响应**恰好**有 result 或 error 之一：两者都缺或都有都会被宿主拒绝。
//
// ============================================================
// 这个版本实现了什么、没实现什么
// ============================================================
//
// 已实现：握手、存活探测、状态上报、优雅停止。也就是**通道本身**。
//
// 尚未实现：插件代码的加载与执行。那需要先定"后台插件能用哪些能力"——
// 界面插件的 `ctx` 里有 DOM 相关的东西（fileDrop、通知浮层），后台环境里没有；
// 而"存储、通知"这些是可以有的。把这条边界定清楚之前照搬 `ctx`，
// 只会让插件在后台静默地半可用。
//
// ============================================================
// 一条曾经的弯路，留在这里以免重走
// ============================================================
//
// 这里曾经实现过一套**定时任务**（间隔/每日/一次性），并让子进程主动向宿主
// 发 `schedule.fired` 事件。它被移除了 —— 连同它的出站事件机制一起。
//
// 原因是实测下来这套东西的整体体验不够好，而它带来的复杂度是实打实的：
// 协议多出一半（事件与响应的区分）、宿主侧多一个读循环分派分支、
// 应用侧多一整套定义/校验/持久化/去重。**通道本身**仍然完整可用；
// 要重新加回"后台能做事"时，值得先想清楚它到底要提供什么能力再动手。
/** 协议版本。必须与 Rust 侧的 PROTOCOL_VERSION 一致。 */
const PROTOCOL_VERSION = 1;

/** 日志前缀。子进程的 stderr 会进应用日志，前缀便于过滤。 */
const LOG_PREFIX = '[background]';

/** 进程启动时刻，用于 `status` 与 `shutdown` 上报的运行时长。 */
const startedAt = Date.now();

/** 已处理过的请求数 */
let handled = 0;

/**
 * 写出**一条**响应。
 *
 * 用一次 `process.stdout.write` 而不是 `console.log(line)` 之外的东西：
 * 一条消息必须**一次**写出去，否则两条响应可能交错，宿主会把它们当成同一行。
 * Node 的 stdout 在管道上是异步的，但单次 write 的字节不会被别的 write 插进来。
 */
function respond(id, { result, error }) {
  const payload = { v: PROTOCOL_VERSION, id };
  // 恰好给一个：两者都给或都不给都会被宿主拒绝（见 protocol.rs 的 validate）。
  if (error !== undefined) {
    payload.error = String(error);
  } else {
    payload.result = result === undefined ? null : result;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** 当前状态。`status` 方法的返回值，也是排查"到底有没有被用过"的依据。 */
function currentStatus() {
  return {
    pid: process.pid,
    protocolVersion: PROTOCOL_VERSION,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    uptimeMs: Date.now() - startedAt,
    handled,
    // 后台插件的加载尚未实现，如实回报 0 而不是编一个数字
    backgroundPlugins: 0,
  };
}

/** 方法表。未知方法返回错误，而不是静默成功。 */
const methods = {
  hello() {
    return { protocolVersion: PROTOCOL_VERSION, runtime: `node/${process.version}` };
  },

  ping() {
    return { pong: true, at: Date.now() };
  },

  status() {
    return currentStatus();
  },

  shutdown() {
    // 响应本身由 `handleLine` 统一发出，这里只描述发生了什么。
    // 退出时机见那里的 `setImmediate` —— 立刻 `process.exit` 会把响应留在
    // 管道缓冲区里，宿主于是只能等超时。
    return { stopping: true, uptimeMs: Date.now() - startedAt };
  },
};

/** 处理一行输入 */
function handleLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch (error) {
    // 一行解析不了**不退出**：对面可能只是写了一条垃圾，而它之后的消息仍然有效。
    // 退出会把一次格式错误升级成"后台功能永久失效"。
    //
    // 没有 id 时无法回应 —— 只记日志。
    process.stderr.write(`${LOG_PREFIX} 无法解析的一行：${error.message}\n`);
    return;
  }

  const id = typeof request?.id === 'number' ? request.id : null;
  if (id === null) {
    process.stderr.write(`${LOG_PREFIX} 请求缺少数字 id，忽略\n`);
    return;
  }

  // 版本不匹配**逐条拒绝**，而不是只在启动时检查一次：
  // 宿主可能已经在运行中被升级，而继续用旧语义解释新字段会得出错误的结论。
  if (request.v !== PROTOCOL_VERSION) {
    respond(id, {
      error:
        `协议版本不匹配：脚本是 ${PROTOCOL_VERSION}，请求是 ${request.v}。` +
        `后台宿主脚本与应用必须来自同一次发布。`,
    });
    return;
  }

  const handler = methods[request.method];
  if (typeof handler !== 'function') {
    // 未知方法必须报错。静默成功会让调用方以为"做完了"，而那是最难发现的一类错误。
    respond(id, { error: `未知方法：${String(request.method)}` });
    return;
  }

  handled += 1;

  try {
    const result = handler(request.params);
    respond(id, { result });

    if (request.method === 'shutdown') {
      // 让它有机会把上面那条响应写出去再退出。
      // `setImmediate` 而不是立刻 `process.exit`：管道写入是异步的，
      // 立刻退出会把刚写的那一行留在缓冲区里 —— 宿主于是看不到响应，
      // 只能等到超时，然后报"后台宿主没有响应"，而它其实好好地停下来了。
      setImmediate(() => {
        process.stderr.write(`${LOG_PREFIX} 收到停止请求，正在退出\n`);
        process.exit(0);
      });
    }
  } catch (error) {
    // 方法抛错 = 业务失败，通道正常。放进 `error` 而不是让进程崩掉：
    // 一个方法的失败不该让整个后台环境消失。
    respond(id, { error: error instanceof Error ? error.message : String(error) });
  }
}

// ============================================================
// 启动
// ============================================================

// 问候必须先于任何其它输出：宿主的第一行读取在等它。
process.stdout.write(
  `${JSON.stringify({
    v: PROTOCOL_VERSION,
    runtime: `node/${process.version}`,
    pid: process.pid,
  })}\n`
);

process.stderr.write(
  `${LOG_PREFIX} 宿主已启动 pid=${process.pid} node=${process.version} 协议=${PROTOCOL_VERSION}\n`
);

let buffer = '';

process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
  buffer += chunk;

  // 逐行处理。最后一段可能是不完整的行，留在缓冲区里等下一次数据 ——
  // 直接按 chunk 边界切会在长消息上出错，而那种错误只在消息恰好跨过
  // 一次读取边界时出现，是最难复现的一类。
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    handleLine(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\n');
  }

  // 兜底：单行过长时不让缓冲区无限增长。上限与 Rust 侧的 MAX_LINE_BYTES 一致 ——
  // 两侧不一致会让"对面为什么突然不说话了"变成一个没有线索的问题。
  if (buffer.length > 1024 * 1024) {
    process.stderr.write(`${LOG_PREFIX} 输入缓冲区超过上限，丢弃未完成的一行\n`);
    buffer = '';
  }
});

process.stdin.on('end', () => {
  // stdin 关闭 = 宿主走了。自己也退，不要留在后台变成孤儿进程。
  process.stderr.write(`${LOG_PREFIX} 标准输入已关闭，宿主退出\n`);
  process.exit(0);
});

// 未捕获异常不能让进程静默死掉：那会让宿主等一个永远不会来的响应，
// 最后报一句"没有响应"，而真正的原因（这里）在日志里。
process.on('uncaughtException', (error) => {
  process.stderr.write(`${LOG_PREFIX} 未捕获异常：${error?.stack ?? error}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`${LOG_PREFIX} 未处理的 Promise 拒绝：${reason}\n`);
});
