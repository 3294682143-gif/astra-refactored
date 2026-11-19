# -*- coding: utf-8 -*-
"""
Zygos (天轭) 一键启动 / 复现脚本
git clone 后运行：  python 一键启动.py  [--port 8000] [--rebuild] [--no-browser]

幂等（可重复运行），自动完成：
  1) 选择 Python >= 3.10
  2) 创建/复用 .venv
  3) 安装 requirements-web.txt（已装则跳过）
  4) 检查 Node >= 18（前端构建与 TS 引擎均需要，推荐 24.x）
  5) 前端 dist 缺失时自动 pnpm install + build（--rebuild 强制重建）
  6) 启动本地服务并打开 http://127.0.0.1:<port>/solve
"""
import os
import sys
import shutil
import subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))
MIN_PY = (3, 10)
MIN_NODE = 18
CREATE_NO_WINDOW = 0x08000000


def _arg(flag, default):
    try:
        i = sys.argv.index(flag)
        return sys.argv[i + 1]
    except Exception:
        return default


PORT = str(_arg("--port", "8000"))
REBUILD = "--rebuild" in sys.argv
NO_BROWSER = "--no-browser" in sys.argv
IS_NT = (os.name == "nt")


def _run(cmd, cwd=None):
    print("  $ " + " ".join(cmd))
    return subprocess.run(cmd, cwd=cwd)


def _py_ver(exe):
    try:
        out = subprocess.check_output(
            [exe, "-c", "import sys;sys.stdout.write('%d.%d'%sys.version_info[:2])"],
            stderr=subprocess.DEVNULL, timeout=15)
        return tuple(int(x) for x in out.decode().strip().split("."))
    except Exception:
        return None


def _venv_py():
    if IS_NT:
        return os.path.join(ROOT, ".venv", "Scripts", "python.exe")
    return os.path.join(ROOT, ".venv", "bin", "python")


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
                    o = subprocess.check_output([py, "-" + ver, "-c", "import sys;sys.stdout.write(sys.executable)"],
                                                stderr=subprocess.DEVNULL, timeout=15)
                    p = o.decode().strip()
                    if p and os.path.isfile(p):
                        cands.append(p)
                except Exception:
                    pass
        for p in (r"C:\Python313\python.exe", r"C:\Python312\python.exe",
                  r"C:\Python311\python.exe", r"C:\Python310\python.exe"):
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
        v = _py_ver(c)
        if v and v >= MIN_PY:
            out.append(c)
    return out


def _deps_ok(vp):
    mods = "sympy,numpy,scipy,requests,pydantic,starlette,uvicorn,httpx"
    return subprocess.run([vp, "-c", "import " + mods],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


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


def ensure_deps(vp):
    if _deps_ok(vp):
        print("[3/6] Python 依赖已就绪")
        return
    req = os.path.join(ROOT, "requirements-web.txt")
    print("[3/6] 安装 Python 依赖（首次，约 1-3 分钟）...")
    if _run([vp, "-m", "pip", "install", "--disable-pip-version-check", "-r", req]).returncode != 0 or not _deps_ok(vp):
        print("[错误] 依赖安装失败。请检查网络后重试，或手动执行：")
        print("        " + vp + " -m pip install -r requirements-web.txt")
        sys.exit(3)


def _node_ver():
    exe = shutil.which("node")
    if not exe:
        return None, None
    try:
        out = subprocess.check_output([exe, "--version"], stderr=subprocess.DEVNULL, timeout=15).decode().strip()
        maj = int(out.lstrip("v").split(".")[0])
        return maj, out
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
        subprocess.run([corepack, "prepare", "pnpm@11.7.0", "--activate"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
        print("[错误] 未找到 pnpm（且 corepack/npm 不可用）。请安装 pnpm 11.7.0 后重试。")
        return _dist_ready()
    print("[4/6] 构建前端（首次，稍候）...")
    if _run([pnpm, "install", "--frozen-lockfile"], cwd=ROOT).returncode != 0:
        print("  [pnpm] --frozen-lockfile 失败，改用普通 install ...")
        if _run([pnpm, "install"], cwd=ROOT).returncode != 0:
            print("[错误] pnpm install 失败。")
            return _dist_ready()
    if _run([pnpm, "build"], cwd=os.path.join(ROOT, "apps", "web-demo")).returncode != 0:
        print("[错误] 前端构建失败（pnpm build）。")
        return _dist_ready()
    return _dist_ready()


def ensure_runtime_bundle():
    b = os.path.join(ROOT, "release", "stdio-runtime.bundle.mjs")
    if os.path.isfile(b):
        return True
    maj, _ = _node_ver()
    if maj is None:
        return False
    s = os.path.join(ROOT, "scripts", "build_stdio_runtime_bundle.mjs")
    if os.path.isfile(s):
        print("  [runtime] 重建 TS 运行时 bundle ...")
        _run([shutil.which("node"), s], cwd=ROOT)
    return os.path.isfile(b)


def start_server(vp):
    env = os.environ.copy()
    env["NO_PROXY"] = "127.0.0.1,localhost"
    flags = CREATE_NO_WINDOW if IS_NT else 0
    ds = os.path.join(ROOT, "scripts", "demo_serve.py")
    print("[6/6] 启动服务： http://127.0.0.1:%s/solve" % PORT)
    if os.path.isfile(ds):
        args = [vp, ds, PORT]
        if NO_BROWSER:
            args.append("--no-browser")
        subprocess.run(args, cwd=ROOT, env=env, creationflags=flags)
        return
    subprocess.run([vp, "-m", "uvicorn", "python.astra_web.app:app",
                    "--host", "127.0.0.1", "--port", PORT], cwd=ROOT, env=env, creationflags=flags)


def main():
    print("=" * 64)
    print("  Zygos (天轭) 一键启动 / 复现")
    print("=" * 64)
    vp = ensure_env()
    ensure_deps(vp)
    fe = ensure_frontend()
    maj, ver = _node_ver()
    if maj is not None and maj >= MIN_NODE:
        print("[5/6] Node " + str(ver))
    else:
        print("[5/6] 警告：未检测到 Node >= 18（解题的 TS 引擎需要；仅浏览界面可忽略）")
    ensure_runtime_bundle()
    if not fe:
        print("[错误] 前端未就绪（缺 dist 且无法构建）。请安装 Node 24.x + pnpm 后重跑。")
        sys.exit(4)
    start_server(vp)
    print("[完成] 服务已在后台运行： http://127.0.0.1:%s/solve" % PORT)
    print("       关闭本窗口不影响服务；重复运行本脚本是安全的（幂等）。")


if __name__ == "__main__":
    main()