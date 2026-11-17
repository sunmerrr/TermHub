// node cdp.js "<JS 식>" — 에뮬레이터 크롬(adb forward된 DevTools)의 테스트 페이지에서 JS를 실행하고 결과를 JSON으로 출력
const WebSocket = require('ws');

const DEVTOOLS = process.env.MTEST_DEVTOOLS || 'http://localhost:6222';
const PAGE_PORT = process.env.MTEST_PORT || '6081';

(async () => {
  const pages = await (await fetch(DEVTOOLS + '/json', { signal: AbortSignal.timeout(5000) })).json();
  const page = pages.find(p => p.type === 'page' && p.url.includes(':' + PAGE_PORT));
  if (!page) throw new Error('테스트 페이지를 찾을 수 없음 (:' + PAGE_PORT + ')');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.on('open', () => ws.send(JSON.stringify({
    id: 1, method: 'Runtime.evaluate',
    params: { expression: process.argv[2], returnByValue: true, awaitPromise: true },
  })));
  ws.on('message', m => {
    const r = JSON.parse(m);
    if (r.id !== 1) return;
    if (r.result.exceptionDetails) { process.stderr.write(JSON.stringify(r.result.exceptionDetails) + '\n'); process.exit(1); }
    process.stdout.write(JSON.stringify(r.result.result.value ?? null) + '\n');
    ws.close();
  });
})().catch(e => { process.stderr.write(String(e) + '\n'); process.exit(1); });
