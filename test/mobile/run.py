#!/usr/bin/env python3
"""폰 입력(LIVE 입력칸)을 안드로이드 에뮬레이터의 실제 Gboard로 검사한다.

키보드 키를 화면 좌표로 진짜 탭하고, 매 단계마다
"입력칸 글자 == 터미널이 받은 바이트(DEL을 지우기로 적용한 결과)"인지 확인한다.

전제: 1080x2400 에뮬레이터(Android Studio 'Medium Phone'), 크롬, Gboard(영어 + 한국어 두벌식).
키 좌표가 이 화면·키보드 배치에 맞춰져 있다 — 다른 기기면 KEYS를 다시 잡아야 한다.
"""
import json, os, re, shutil, subprocess, sys, time, urllib.request
from http.cookiejar import CookieJar

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get('MTEST_DIR', '/tmp/termhub-mtest')
PORT = os.environ.get('MTEST_PORT', '6081')
DEVTOOLS_PORT = '6222'
BASE = f'http://localhost:{PORT}'
LOG = os.path.join(WORK, 'keys.log')
SDK = os.path.expanduser(os.environ.get('ANDROID_HOME', '~/Library/Android/sdk'))
ADB = os.environ.get('ADB') or shutil.which('adb') or os.path.join(SDK, 'platform-tools/adb')
EMULATOR = os.path.join(SDK, 'emulator/emulator')
GBOARD = 'com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME'

# Gboard 키 위치 (기기 픽셀). 두벌식 한글 자판은 QWERTY와 같은 자리라 영문 글자로 친다 (r=ㄱ, k=ㅏ …)
ROWS = [('qwertyuiop', [58, 164, 271, 378, 486, 593, 700, 808, 914, 1021], 1716),
        ('asdfghjkl', [112, 218, 325, 432, 539, 646, 754, 859, 966], 1868),
        ('zxcvbnm', [218, 325, 432, 539, 646, 754, 859], 2024)]
KEYS = {c: (x, y) for chars, xs, y in ROWS for c, x in zip(chars, xs)}
KEYS.update({' ': (593, 2178), '\b': (994, 2024), '\n': (994, 2178)})
GLOBE = (325, 2178)
MIDDLE_SUGGESTION = (538, 1574)


def adb(*args, check=True):
    return subprocess.run([ADB, *args], capture_output=True, text=True, check=check).stdout


def tap(x, y):
    adb('shell', 'input', 'touchscreen', 'tap', str(x), str(y))


def type_keys(text):
    for c in text:
        tap(*KEYS[c])
        time.sleep(0.12)


def js(expr):
    out = subprocess.run(['node', os.path.join(HERE, 'cdp.js'), expr], capture_output=True, text=True,
                         env={**os.environ, 'MTEST_PORT': PORT})
    if out.returncode:
        raise RuntimeError(out.stderr.strip())
    return json.loads(out.stdout)


def ui_bounds(resource_id):
    adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml')
    xml = adb('shell', 'cat', '/sdcard/ui.xml')
    m = re.search(r'resource-id="[^"]*' + re.escape(resource_id) + r'"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
    return tuple(map(int, m.groups())) if m else None


def terminal_line():
    """기록된 입력 바이트에 DEL을 적용해 [엔터로 끝난 줄들, 아직 입력 중인 줄]을 만든다. 줄바꿈(ESC CR)은 줄 안의 \n이다"""
    raw = open(LOG, 'rb').read().decode('utf-8', 'replace')
    lines, cur = [], []
    for ch in raw:
        if ch == '\x7f':
            if cur:
                cur.pop()
        elif ch == '\r' and cur and cur[-1] == '\x1b':
            cur[-1] = '\n'
        elif ch == '\r':
            lines.append(''.join(cur))
            cur = []
        else:
            cur.append(ch)
    return lines, ''.join(cur)


def field():
    return js('document.getElementById("inp-1").value')


results = []


def check(name, expect_field=None, wait=1.0):
    # 안드로이드는 조합 상태를 알 수 없어 끝 글자를 300ms 붙잡았다 보낸다 — 넉넉히 기다린다
    time.sleep(wait)
    f, (_, t) = field(), terminal_line()
    t = t.split('\n')[-1]  # 줄바꿈 뒤 입력창은 새 줄부터 시작한다
    ok = f == t and (expect_field is None or f == expect_field)
    results.append(ok)
    print(('PASS' if ok else 'FAIL'), f'[{name}] 입력칸={f!r} 터미널={t!r}' + ('' if expect_field is None else f' 기대={expect_field!r}'))


def check_enter(name, expect_line):
    time.sleep(1.0)
    f, (lines, t) = field(), terminal_line()
    ok = f == '' and t == '' and lines and lines[-1] == expect_line
    results.append(ok)
    print(('PASS' if ok else 'FAIL'), f'[{name}] 보낸 줄={lines[-1] if lines else None!r} 기대={expect_line!r} 입력칸={f!r}')


def check_newline(name, expect_text):
    time.sleep(1.0)
    f, (_, t) = field(), terminal_line()
    ok = f == '' and t == expect_text + '\n'
    results.append(ok)
    print(('PASS' if ok else 'FAIL'), f'[{name}] 터미널={t!r} 기대={expect_text + chr(10)!r} 입력칸={f!r}')


def ensure_device():
    if adb('get-state', check=False).strip() == 'device':
        return
    avd = os.environ.get('MTEST_AVD') or subprocess.run([EMULATOR, '-list-avds'], capture_output=True, text=True).stdout.split()[0]
    print(f'에뮬레이터 부팅: {avd}')
    subprocess.Popen([EMULATOR, '-avd', avd, '-no-snapshot-save', '-no-boot-anim'],
                     stdout=open(os.path.join(WORK, 'emulator.log'), 'w'), stderr=subprocess.STDOUT)
    adb('wait-for-device')
    while adb('shell', 'getprop', 'sys.boot_completed', check=False).strip() != '1':
        time.sleep(3)


def start_server():
    os.makedirs(WORK, exist_ok=True)
    srv = subprocess.Popen(['bash', os.path.join(HERE, 'server.sh')],
                           stdout=open(os.path.join(WORK, 'server.log'), 'w'), stderr=subprocess.STDOUT)
    for _ in range(30):
        try:
            urllib.request.urlopen(BASE + '/', timeout=1)
            return srv
        except OSError:
            time.sleep(0.5)
    srv.kill()
    sys.exit(f'테스트 서버가 뜨지 않음 — {WORK}/server.log 확인')


def spawn_worker():
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    post = lambda path, body: json.loads(opener.open(urllib.request.Request(
        BASE + path, json.dumps(body).encode(), {'Content-Type': 'application/json'})).read())
    post('/api/login', {'pw': 'mtest'})
    # 진짜 셸을 띄우되 들어오는 입력 바이트만 기록한다
    return post('/api/spawn', {'cwd': WORK, 'cmd': f'python3 {HERE}/keytap.py {LOG}'})['id']


def open_page():
    adb('reverse', f'tcp:{PORT}', f'tcp:{PORT}')
    adb('forward', f'tcp:{DEVTOOLS_PORT}', 'localabstract:chrome_devtools_remote')
    # 한국어를 막 추가한 Gboard는 다시 붙이기 전까지 자모를 조합하지 않는다
    adb('shell', 'ime', 'set', GBOARD)
    # 에뮬레이터 창을 마우스로 누르면 스타일러스 입력으로 들어와 Gboard가 필기 툴바만 띄운다 — 필기 입력을 끄고 Gboard를 다시 띄운다
    adb('shell', 'settings', 'put', 'secure', 'stylus_handwriting_enabled', '0')
    adb('shell', 'am', 'force-stop', GBOARD.split('/')[0])
    adb('shell', 'ime', 'set', GBOARD)
    # 지난 실행의 탭이 남아 있으면 cdp.js가 보이지 않는 탭을 잡을 수 있다 — 테스트 페이지 탭을 모두 닫는다
    try:
        # 크롬이 꺼져 있으면 adb forward가 연결만 받고 응답이 없다 — 타임아웃 필수
        for p in json.loads(urllib.request.urlopen(f'http://localhost:{DEVTOOLS_PORT}/json', timeout=3).read()):
            if p.get('type') == 'page' and f':{PORT}' in p.get('url', ''):
                urllib.request.urlopen(f'http://localhost:{DEVTOOLS_PORT}/json/close/{p["id"]}', timeout=3)
    except OSError:
        pass  # 크롬이 아직 안 떠 있으면 닫을 탭도 없다
    adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', BASE + '/', 'com.android.chrome')
    time.sleep(4)
    for button in ('signin_fre_dismiss_button', 'negative_button'):  # 크롬 첫 실행 화면
        b = ui_bounds(button)
        if b:
            tap((b[0] + b[2]) // 2, (b[1] + b[3]) // 2)
            time.sleep(2)
    js(f'fetch("/api/login", {{method: "POST", headers: {{"Content-Type": "application/json"}}, body: JSON.stringify({{pw: "mtest"}})}})'
       '.then(() => { localStorage.removeItem("liveMirrorInput"); location.reload(); })')
    for _ in range(20):
        time.sleep(1)
        try:
            if js('!!document.getElementById("inp-1")'):
                return
        except RuntimeError:
            pass
    sys.exit('테스트 페이지에서 입력칸(inp-1)을 찾지 못함')


def focus_field():
    # 페이지가 막 그려지는 중이면 입력칸 위치가 바뀌어 탭이 빗나간다 — 키보드가 뜰 때까지 다시 누른다
    for _ in range(5):
        tap_field()
        if 'mInputShown=true' in adb('shell', 'dumpsys', 'input_method') and js('document.activeElement.id') == 'inp-1':
            return
        time.sleep(1)
    sys.exit('입력칸을 눌러도 키보드가 뜨지 않음')


def tap_field():
    js('(() => { document.getElementById("inp-1").scrollIntoView(); return 1; })()')
    r = js('(() => { const r = document.getElementById("inp-1").getBoundingClientRect();'
           ' return [r.left + r.width / 2, r.top + r.height / 2, innerHeight, devicePixelRatio]; })()')
    cx, cy, ih, dpr = r
    web = ui_bounds('compositor_view_holder')
    bottom = web[3] if web else 2337
    tap(int(cx * dpr), int(bottom - (ih - cy) * dpr))
    time.sleep(1.5)


def use_layout(korean):
    for _ in range(4):
        type_keys('a')
        time.sleep(0.8)
        now = field()
        type_keys('\b')
        time.sleep(0.8)
        if now not in ('a', 'ㅁ'):
            sys.exit(f'화면 키보드로 입력되지 않음 (입력칸={now!r}) — 키보드가 떠 있는지 확인')
        if (now == 'ㅁ') == korean:
            return
        tap(*GLOBE)
        time.sleep(1)
    sys.exit('Gboard 언어를 바꾸지 못함 — Gboard에 한국어(두벌식)가 추가돼 있어야 한다')


def main():
    ensure_device()
    srv = start_server()
    try:
        spawn_worker()
        open_page()
        focus_field()

        use_layout(korean=False)
        open(LOG, 'wb').close()
        type_keys('hello wrold'); check('영문 입력', 'hello wrold')
        type_keys('\b\b\b\b'); type_keys('orld'); check('오타 지우고 다시 쓰기', 'hello world')
        type_keys(' tset'); check('추천 단어 직전')
        tap(*MIDDLE_SUGGESTION); check('Gboard 추천 단어로 바꾸기')
        before = field()
        type_keys('\b' * 6); type_keys(' ok'); check('띄어쓰기 넘어 지우고 다시 쓰기')
        expect = field()
        type_keys('\n'); check_newline('줄바꿈', expect)
        type_keys('\n'); check_enter('빈 입력창 엔터로 보내기', expect + '\n')
        if before == expect:
            print('  (추천 단어가 아무것도 바꾸지 않았다)')

        use_layout(korean=True)
        type_keys('dkssudgktpdy'); check('한글 안녕하세요', '안녕하세요')
        type_keys('\n'); check_newline('조합 중 줄바꿈', '안녕하세요')
        type_keys('\n'); check_enter('빈 입력창 엔터로 보내기', '안녕하세요\n')
        type_keys('gksrmf'); check('한글', '한글')
        type_keys('\b'); check('조합 중 지우기', '한그')
        type_keys('f'); check('다시 조합', '한글')
        type_keys(' xptmxm'); check('띄어쓰고 이어 쓰기', '한글 테스트')
        type_keys('\b' * 5); check('띄어쓰기 넘어 지우기')
        type_keys(' dkssud'); check('다시 쓰기')
        expect = field()
        type_keys('\n'); check_newline('줄바꿈', expect)
        type_keys('\n'); check_enter('빈 입력창 엔터로 보내기', expect + '\n')

        # 한글로 썼다 지웠다 반복 — Gboard는 조합 중엔 자모 단위로, 확정된 글자는 글자 단위로 지우므로 기대값 대신 입력칸==터미널만 본다
        for r in range(3):
            type_keys('rhdiddl'); check(f'[{r}] 고양이', '고양이')
            type_keys('\b\b'); check(f'[{r}] 조합 중 두 번 지우기')
            type_keys('dl'); check(f'[{r}] 다시 쓰기', '고양이')
            type_keys(' qkek'); check(f'[{r}] 띄어 쓰기', '고양이 바다')
            type_keys('\b' * 4); check(f'[{r}] 띄어쓰기 넘어 지우기')
            type_keys(' skan'); check(f'[{r}] 다른 낱말로 다시 쓰기')
            type_keys('gks\brmf\b\bfrkatk'); check(f'[{r}] 쓰다 지우다 섞어 치기')
            type_keys('\b' * 30); check(f'[{r}] 전부 지우기', '')
            type_keys('tkfkd'); check(f'[{r}] 지운 뒤 새로 쓰기', '사랑')
            expect = field()
            type_keys('\n'); check_newline(f'[{r}] 줄바꿈', expect)
            type_keys('rkatk'); check(f'[{r}] 둘째 줄', '감사')
            type_keys('\b' * 2); check(f'[{r}] 둘째 줄 지우기')
            lines, t = terminal_line()
            type_keys('dkssud'); check(f'[{r}] 다시 쓰기 안녕')
            type_keys('\n'); time.sleep(1.0)
            type_keys('\n'); time.sleep(1.0)
            lines2, t2 = terminal_line()
            ok = field() == '' and t2 == '' and len(lines2) == len(lines) + 1
            results.append(ok)
            print(('PASS' if ok else 'FAIL'), f'[[{r}] 보내기] 보낸 줄={lines2[-1] if lines2 else None!r} 입력칸={field()!r}')
    finally:
        srv.terminate()
        subprocess.run(['tmux', '-S', os.path.join(WORK, 'tmux', f'tmux-{os.getuid()}', 'default'), 'kill-server'],
                       capture_output=True, env={k: v for k, v in os.environ.items() if k != 'TMUX'})

    failed = results.count(False)
    print(f'\n{len(results) - failed}/{len(results)} 통과')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
