# -*- coding: utf-8 -*-
# 启动.pyw — 双击即可（用 pythonw 运行，不弹黑框）。参数透传。
import os, sys
_here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _here)
import runpy
runpy.run_path(os.path.join(_here, "启动.py"), run_name="__main__")