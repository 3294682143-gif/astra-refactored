"""Start the mode-A (scripted) demo server DETACHED from the current console/process
group, so an external console-group termination on this machine cannot take the
long-lived server down. Then open http://127.0.0.1:<port>/solve in a browser.

Usage:  python scripts/demo_serve.py [port] [--no-browser] [--foreground]
"""
import os, subprocess, sys, time, json, urllib.request, webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Ensure proxy doesn't intercept localhost calls
os.environ["NO_PROXY"] = "127.0.0.1,localhost"

# Detect Python interpreter
def find_python() -> str:
    candidates = [
        ROOT / ".venv" / "Scripts" / "python.exe",
        ROOT / "venv" / "Scripts" / "python.exe",
        ROOT / ".venv" / "bin" / "python",
        ROOT / "venv" / "bin" / "python",
        Path(sys.executable),
    ]
    for c in candidates:
        if c.is_file():
            return str(c)
    return sys.executable

PY = find_python()

# Parse args
port = 8000
no_browser = "--no-browser" in sys.argv
foreground = "--foreground" in sys.argv
for arg in sys.argv[1:]:
    if arg.isdigit():
        port = int(arg)

varlog = ROOT / "var"
varlog.mkdir(exist_ok=True)
out = open(varlog / "demo_serve.out.log", "wb")
err = open(varlog / "demo_serve.err.log", "wb")

cmd = [PY, "-X", "faulthandler", str(ROOT / "scripts" / "web_demo_server.py"), "--port", str(port), "--drop-events-after", "9999"]

if foreground:
    print(f"Starting server in foreground on http://127.0.0.1:{port}/solve ...")
    subprocess.run(cmd, cwd=str(ROOT))
    sys.exit(0)

creationflags = 0
if os.name == "nt":
    creationflags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP

p = subprocess.Popen(
    cmd,
    cwd=str(ROOT),
    creationflags=creationflags,
    stdin=subprocess.DEVNULL,
    stdout=out,
    stderr=err,
    start_new_session=(os.name != "nt"),
)

healthy = False
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for _ in range(40):
    time.sleep(0.5)
    if p.poll() is not None:
        print("!! server exited during startup, see var/demo_serve.err.log")
        break
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/health")
        resp = opener.open(req, timeout=2)
        r = json.loads(resp.read().decode())
        if r.get("status") == "ok":
            healthy = True
            url = f"http://127.0.0.1:{port}/solve"
            print(f"OK  demo server running (pid={p.pid}) on {url}")
            print("    solver_configured:", r.get("execution", {}).get("solver_configured"))
            if not no_browser:
                try:
                    webbrowser.open(url)
                    print(f"    Opened browser at {url}")
                except Exception:
                    pass
            break
    except Exception:
        pass

if not healthy:
    print("!! health check failed; check var/demo_serve.err.log")
    raise SystemExit(3)
