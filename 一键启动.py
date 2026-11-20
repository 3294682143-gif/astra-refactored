# -*- coding: utf-8 -*-
"""
Zygos (天轭) 一键启动 / 复现脚本
git clone 后运行：  python 一键启动.py  [--port 8000] [--rebuild] [--no-browser] [--fix-proxy]

幂等。自动：选 Python>=3.10 -> 建 .venv -> 装依赖(代理感知+失败诊断) -> 需时构建前端
-> 启动服务 -> 真校验 /api/health(杜绝假成功) -> 打开浏览器。
"""
import os
import sys
import json
import shutil
import subprocess
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
MIN_PY = (3, 10)
MIN_NODE = 18
CREATE_NO_WINDOW = 0x08000000
IS_NT = (os.name == "nt")


def _arg(flag, default):
    try:
        return sys.argv[sys.argv.index(flag) + 1]
    except Exception:
        return default


PORT = str(_arg("--port", "8000"))
REBUILD = "--rebuild" in sys.argv
NO_BROWSER = "--no-browser" in sys.argv
FIX_PROXY = "--fix-proxy" in sys.argv


def _run(cmd, cwd=None, env=None):
    print("  $ " + " ".join(cmd))
    return subprocess.run(cmd, cwd=cwd, env=env)


def _py_ver(exe):
    try:
        out = subprocess.check_output(
            [exe, "-c", "import sys;sys.stdout.write('%d.%d'%sys.version_info[:2])"],
            stderr=subprocess.DEVNULL, timeout=15)
        return tuple(int(x) for x in out.decode().strip().split("."))
    except Exception:
        return None


def _venv_py():
    return os.path.join(ROOT, ".venv", "Scripts", "python.exe") if IS_NT else os.path.join(ROOT, ".venv", "bin", "python")


def _find_python():
    cands = []
    v = _py_ver(sys.executable)
    if v and v >= MIN_PY:
        cands.append(sys.executable)
    if IS_NT:
        py = shutil.which("py")
        if py:
            for ver in ("3.13", "3.12", "3.11", "3.10"):
                try:
                    o = subprocess.check_output([py, "-" + ver, "-c", "import sys;sys.stdout.write(sys.executable)"], stderr=subprocess.DEVNULL, timeout=15)
                    p = o.decode().strip()
                    if p and os.path.isfile(p):
                        cands.append(p)
                except Exception:
                    pass
        for p in (r"C:\Python313\python.exe", r"C:\Python312\python.exe", r"C:\Python311\python.exe", r"C:\Python310\python.exe"):
            if os.path.isfile(p):
                cands.append(p)
    for name in ("python3.13", "python3.12", "python3.11", "python3.10", "python3"):
        w = shutil.which(name)
        if w:
            cands.append(w)
    seen, out = set(), []
    for c in cands:
        k = os.path.normcase(os.path.abspath(c))
        if k in seen:
            continue
        seen.add(k)
        if _py_ver(c) and _py_ver(c) >= MIN_PY:
            out.append(c)
    return out


def _deps_ok(vp):
    mods = "sympy,numpy,scipy,requests,pydantic,starlette,uvicorn,httpx"
    return subprocess.run([vp, "-c", "import " + mods], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def ensure_env():
    vp = _venv_py()
    if os.path.isfile(vp):
        v = _py_ver(vp)
        if v and v >= MIN_PY:
            print("[1-2/6] 复用现有 .venv (Python %d.%d)" % v)
            return vp
    bases = _find_python()
    if not bases:
        print("[错误] 未找到 Python >= 3.10。请安装后重试： https://www.python.org/downloads/")
        sys.exit(2)
    base = bases[0]
    print("[1/6] 使用 Python: " + base)
    if os.path.isdir(os.path.join(ROOT, ".venv")):
        shutil.rmtree(os.path.join(ROOT, ".venv"), ignore_errors=True)
    print("[2/6] 创建 .venv ...")
    if _run([base, "-m", "venv", os.path.join(ROOT, ".venv")]).returncode != 0:
        print("[错误] 创建虚拟环境失败。")
        sys.exit(2)
    return _venv_py()


def _detect_proxy():
    info = {"env": {}, "sys_enabled": False, "sys_server": "", "override": ""}
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy"):
        if os.environ.get(k):
            info["env"][k] = os.environ[k]
    if IS_NT:
        try:
            import winreg
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
            try:
                info["sys_enabled"] = bool(winreg.QueryValueEx(key, "ProxyEnable")[0])
            except Exception:
                pass
            try:
                info["sys_server"] = str(winreg.QueryValueEx(key, "ProxyServer")[0])
            except Exception:
                pass
            try:
                info["override"] = str(winreg.QueryValueEx(key, "ProxyOverride")[0])
            except Exception:
                pass
            winreg.CloseKey(key)
        except Exception:
            pass
    return info


def _proxy_bypasses_localhost(px):
    if not px["sys_enabled"]:
        return True
    ov = (px["override"] or "").lower()
    return ("127.0.0.1" in ov) or ("localhost" in ov) or ("<local>" in ov)


def _fix_proxy_bypass():
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Internet Settings", 0, winreg.KEY_READ | winreg.KEY_WRITE)
        try:
            override = str(winreg.QueryValueEx(key, "ProxyOverride")[0])
        except Exception:
            override = ""
        parts = [p for p in override.split(";") if p]
        changed = False
        for host in ("127.0.0.1", "localhost", "<local>"):
            if host not in parts:
                parts.append(host)
                changed = True
        if changed:
            winreg.SetValueEx(key, "ProxyOverride", 0, winreg.REG_SZ, ";".join(parts))
        winreg.CloseKey(key)
        try:
            import ctypes
            ctypes.windll.wininet.InternetSetOptionW(0, 39, 0, 0)  # SETTINGS_CHANGED
            ctypes.windll.wininet.InternetSetOptionW(0, 37, 0, 0)  # REFRESH
        except Exception:
            pass
        print("  [代理] 已将 127.0.0.1;localhost;<local> 加入系统代理绕过并刷新。请关闭旧标签后重开页面。")
        return True
    except Exception as e:
        print("  [代理] 自动修复失败：" + str(e))
        return False


def ensure_deps(vp):
    if _deps_ok(vp):
        print("[3/6] Python 依赖已就绪")
        return
    req = os.path.join(ROOT, "requirements-web.txt")
    print("[3/6] 安装 Python 依赖（首次，约 1-3 分钟）...")
    rc = _run([vp, "-m", "pip", "install", "--disable-pip-version-check", "-r", req], cwd=ROOT).returncode
    if rc == 0 and _deps_ok(vp):
        return
    print("[3/6] 首次安装失败，尝试【绕过代理 + 清华镜像】重试 ...")
    env = os.environ.copy()
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy"):
        env.pop(k, None)
    env["NO_PROXY"] = "*"
    env["no_proxy"] = "*"
    rc2 = _run([vp, "-m", "pip", "install", "--disable-pip-version-check",
                "-i", "https://pypi.tuna.tsinghua.edu.cn/simple",
                "--trusted-host", "pypi.tuna.tsinghua.edu.cn", "-r", req], cwd=ROOT, env=env).returncode
    if rc2 == 0 and _deps_ok(vp):
        print("[3/6] 依赖已安装（已绕过代理）。")
        return
    px = _detect_proxy()
    print("[错误] Python 依赖安装失败。检测到的代理信息：")
    if px["env"]:
        print("   环境变量代理: " + json.dumps(px["env"], ensure_ascii=False))
    if px["sys_enabled"]:
        print("   Windows 系统代理: " + px["sys_server"] + "  (绕过列表: " + (px["override"] or "空") + ")")
        print("   常见原因：系统代理(如 127.0.0.1:7897)未运行/节点失效，pip 走代理因而全部下载失败。")
    print("   可操作方案（任选其一）：")
    print("    1) 关闭系统代理后重跑本脚本；或")
    print("    2) 在代理软件里把 127.0.0.1;localhost 加入绕过列表；或")
    print("    3) 临时绕过代理安装（PowerShell）：")
    print("       $env:NO_PROXY='*'; $env:HTTP_PROXY=''; $env:HTTPS_PROXY=''; " + vp + " -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements-web.txt")
    sys.exit(3)


def _node_ver():
    exe = shutil.which("node")
    if not exe:
        return None, None
    try:
        out = subprocess.check_output([exe, "--version"], stderr=subprocess.DEVNULL, timeout=15).decode().strip()
        return int(out.lstrip("v").split(".")[0]), out
    except Exception:
        return None, None


def _ensure_pnpm():
    p = shutil.which("pnpm")
    if p:
        return p
    corepack = shutil.which("corepack")
    if corepack:
        print("  [pnpm] 用 corepack 启用 pnpm@11.7.0 ...")
        subprocess.run([corepack, "enable"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run([corepack, "prepare", "pnpm@11.7.0", "--activate"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        p = shutil.which("pnpm")
        if p:
            return p
    npm = shutil.which("npm")
    if npm:
        print("  [pnpm] 用 npm 安装 pnpm@11.7.0 ...")
        subprocess.run([npm, "i", "-g", "pnpm@11.7.0"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        p = shutil.which("pnpm")
        if p:
            return p
    return None


def _dist_ready():
    return os.path.isfile(os.path.join(ROOT, "apps", "web-demo", "dist", "index.html"))


def ensure_frontend():
    if _dist_ready() and not REBUILD:
        print("[4/6] 前端已构建（跳过；--rebuild 可强制重建）")
        return True
    maj, ver = _node_ver()
    if maj is None or maj < MIN_NODE:
        print("[警告] 未检测到 Node.js >= 18（前端构建与 TS 引擎都需要，推荐 24.x：https://nodejs.org/）")
        if _dist_ready():
            print("        已有前端 dist，继续使用现有构建。")
            return True
        return False
    pnpm = _ensure_pnpm()
    if not pnpm:
        print("[错误] 未找到 pnpm（corepack/npm 也不可用）。请安装 pnpm 11.7.0 后重试。")
        return _dist_ready()
    print("[4/6] 构建前端（首次，稍候；如遇 esbuild 构建脚本被忽略，请运行 pnpm approve-builds）...")
    if _run([pnpm, "install", "--frozen-lockfile"], cwd=ROOT).returncode != 0:
        print("  [pnpm] --frozen-lockfile 失败，改用普通 install ...")
        if _run([pnpm, "install"], cwd=ROOT).returncode != 0:
            print("[错误] pnpm install 失败。")
            return _dist_ready()
    if _run([pnpm, "build"], cwd=os.path.join(ROOT, "apps", "web-demo")).returncode != 0:
        print("[错误] 前端构建失败（pnpm build）。若提示 esbuild 未构建，请执行 pnpm approve-builds 后重试。")
        return _dist_ready()
    return _dist_ready()


def ensure_runtime_bundle():
    b = os.path.join(ROOT, "release", "stdio-runtime.bundle.mjs")
    if os.path.isfile(b):
        return True
    if _node_ver()[0] is None:
        return False
    s = os.path.join(ROOT, "scripts", "build_stdio_runtime_bundle.mjs")
    if os.path.isfile(s):
        print("  [runtime] 重建 TS 运行时 bundle ...")
        _run([shutil.which("node"), s], cwd=ROOT)
    return os.path.isfile(b)


def _health_ok(port):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 绕过代理直连本机
    try:
        with opener.open("http://127.0.0.1:%s/api/health" % port, timeout=6) as r:
            data = json.loads(r.read().decode("utf-8"))
            return data.get("status") == "ok"
    except Exception:
        return False


def start_server(vp):
    env = os.environ.copy()
    env["NO_PROXY"] = "127.0.0.1,localhost"
    env["no_proxy"] = "127.0.0.1,localhost"
    print("[6/6] 启动服务： http://127.0.0.1:%s/solve" % PORT)
    ds = os.path.join(ROOT, "scripts", "demo_serve.py")
    if os.path.isfile(ds):
        args = [vp, ds, PORT] + (["--no-browser"] if NO_BROWSER else [])
        return _run(args, cwd=ROOT, env=env).returncode
    return _run([vp, "-m", "uvicorn", "python.astra_web.app:app", "--host", "127.0.0.1", "--port", PORT], cwd=ROOT, env=env).returncode


def main():
    print("=" * 64)
    print("  Zygos (天轭) 一键启动 / 复现")
    print("=" * 64)
    vp = ensure_env()
    ensure_deps(vp)
    fe = ensure_frontend()
    maj, ver = _node_ver()
    print(("[5/6] Node " + str(ver)) if (maj is not None and maj >= MIN_NODE) else "[5/6] 警告：未检测到 Node >= 18（解题的 TS 引擎需要；仅浏览界面可忽略）")
    ensure_runtime_bundle()
    if not fe:
        print("[错误] 前端未就绪（缺 dist 且无法构建）。请安装 Node 24.x + pnpm 后重跑。")
        sys.exit(4)

    px = _detect_proxy()
    if not _proxy_bypasses_localhost(px):
        if FIX_PROXY:
            _fix_proxy_bypass()
        else:
            print("[代理提示] 检测到系统代理开启且未绕过本机：浏览器可能因此连不上后端。")
            print("          运行  python 一键启动.py --fix-proxy  可自动把 127.0.0.1;localhost 加入代理绕过。")

    rc = start_server(vp)
    if rc != 0:
        print("[错误] 服务启动失败（退出码 %d）。请查看 var/demo_serve.err.log" % rc)
        sys.exit(5)
    if not _health_ok(PORT):
        print("[错误] 服务未通过健康检查（/api/health 不可用）。请查看 var/demo_serve.err.log")
        sys.exit(5)
    print("[完成] 服务已就绪并通过健康检查： http://127.0.0.1:%s/solve" % PORT)
    print("       若浏览器显示后端未连接：关闭旧标签重开，或运行 --fix-proxy 把本机加入代理绕过。")
    print("       关闭本窗口不影响服务；重复运行本脚本安全（幂等）。")


if __name__ == "__main__":
    main()