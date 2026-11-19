# -*- coding: utf-8 -*-
"""
Zygos (天轭) 一键启动
用法：双击本文件，或终端运行  python 启动.py  [端口，默认8000]

策略（尽量"直接启动"）：
1) 优先用【现成且依赖齐全】的解释器直接起服务——不建环境、不装依赖（与手动跑一致）。
2) 只有当没有任何解释器具备依赖时，才自动建 .venv 并安装一次。
本启动器自身兼容 3.10 以下；找不到 3.10+ 会弹窗提示，不会卡住。
"""
import os, sys, subprocess, shutil, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = "8000"
for a in sys.argv[1:]:
    if a.isdigit():
        PORT = a
MIN = (3, 10)
CREATE_NO_WINDOW = 0x08000000
REQ = "starlette,uvicorn,pydantic,sympy,numpy,scipy,httpx"

def _alert(msg):
    print(msg)
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, msg, "Zygos 天轭 启动器", 0x40)
    except Exception:
        try: time.sleep(8)
        except Exception: pass

def _fail(msg):
    _alert(msg); sys.exit(1)

def _ver(exe):
    try:
        out = subprocess.check_output([exe, "-c", "import sys;sys.stdout.write('%d.%d'%sys.version_info[:2])"],
                                      stderr=subprocess.DEVNULL, timeout=15)
        return tuple(int(x) for x in out.decode().strip().split("."))
    except Exception:
        return None

def ok10(exe):
    v = _ver(exe); return v is not None and v >= MIN

def has_deps(exe):
    try:
        return subprocess.run([exe, "-c", "import " + REQ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30).returncode == 0
    except Exception:
        return False

def venv_py():
    if os.name == "nt":
        return str(ROOT / ".venv" / "Scripts" / "python.exe")
    return str(ROOT / ".venv" / "bin" / "python")

def find_bases():
    cands = []
    if sys.executable and ok10(sys.executable): cands.append(sys.executable)
    py = shutil.which("py")
    if py:
        for v in ("3.13", "3.12", "3.11", "3.10"):
            try:
                out = subprocess.check_output([py, "-" + v, "-c", "import sys;sys.stdout.write(sys.executable)"],
                                              stderr=subprocess.DEVNULL, timeout=15)
                p = out.decode().strip()
                if p and os.path.isfile(p): cands.append(p)
            except Exception: pass
    for name in ("python3.12", "python3.11", "python3.10", "python3"):
        w = shutil.which(name)
        if w: cands.append(w)
    for p in (r"C:\Python313\python.exe", r"C:\Python312\python.exe", r"C:\Python311\python.exe", r"C:\Python310\python.exe"):
        if os.path.isfile(p): cands.append(p)
    seen=set(); out=[]
    for c in cands:
        k=os.path.normcase(os.path.abspath(c))
        if k not in seen: seen.add(k); out.append(c)
    return out

def pick_prepared():
    """返回(解释器, 是否已具备依赖)。优先现成 .venv，其次系统/发现的 3.10+。"""
    ordered = []
    v = venv_py()
    if os.path.isfile(v) and ok10(v): ordered.append(v)
    for b in find_bases():
        if b not in ordered: ordered.append(b)
    # 先找"依赖齐全"的，直接启动不装
    for c in ordered:
        if has_deps(c):
            return c, True
    # 没有具备依赖的；返回第一个 3.10+ 作为建环境的基础
    for c in ordered:
        if ok10(c):
            return c, False
    return None, False

def ensure_ready():
    exe, ready = pick_prepared()
    if exe is None:
        cur = "%d.%d" % sys.version_info[:2]
        _fail("[需要 Python 3.10+] 未找到 3.10 及以上的 Python（当前 " + cur + "）。\n"
              "本程序的推理服务需要 Python >= 3.10。请安装后重试（https://www.python.org/downloads/ ，勾选 Add to PATH）。")
    if ready:
        print("[环境] 使用已就绪解释器直接启动（无需安装依赖）：" + exe)
        return exe
    # 需要建环境+装依赖（仅此情况才联网安装）
    base = exe
    print("[环境] 未发现已装依赖的解释器，使用 " + base + " 创建 .venv 并安装依赖（仅首次）...")
    if os.path.isdir(str(ROOT / ".venv")):
        shutil.rmtree(str(ROOT / ".venv"), ignore_errors=True)
    subprocess.run([base, "-m", "venv", str(ROOT / ".venv")])
    vpy = venv_py()
    if not os.path.isfile(vpy):
        _fail("[错误] 创建虚拟环境失败。")
    args = [vpy, "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")]
    req2 = str(ROOT / "requirements-dev.txt")
    if os.path.isfile(req2): args += ["-r", req2]
    if subprocess.run(args).returncode != 0 or not has_deps(vpy):
        _fail("[错误] 依赖安装失败。请检查网络后重试，或手动执行：\n  " + vpy + " -m pip install -r requirements.txt -r requirements-dev.txt")
    return vpy

def main():
    print("Zygos(天轭) 一键启动 ...")
    vpy = ensure_ready()
    os.environ["NO_PROXY"] = "127.0.0.1,localhost"
    print("[启动] 无窗口后台启动服务（端口 " + PORT + "）...")
    flags = CREATE_NO_WINDOW if os.name == "nt" else 0
    r = subprocess.run([vpy, str(ROOT / "scripts" / "demo_serve.py"), PORT], cwd=str(ROOT), creationflags=flags)
    if r.returncode != 0:
        _fail("[错误] 服务启动失败，请查看 var/demo_serve.err.log")
    print("[完成] 服务已在后台运行：http://127.0.0.1:" + PORT + "/solve")
    print("        浏览器应已自动打开；关闭本窗口不影响服务。")
    try: time.sleep(2)
    except Exception: pass

if __name__ == "__main__":
    main()