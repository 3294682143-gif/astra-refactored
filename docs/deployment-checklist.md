# 本地工作站部署验收清单（F-07）

* 形态：本地工作站（方案 §21.1 第一形态）；其余两形态（课题组服务器/机构环境）如实标注"建设中，未验收"
* 实测日期：2026-10-30；环境：Windows 11（中文路径 `D:\书生`，非 ASCII 路径兼容已验证）

## 一键启动
| 步骤 | 命令 | 验收点 |
|---|---|---|
| 1 | `scripts\start_demo.bat`（或 `python scripts/start_demo.py`） | 三进程拉起：BFF(8011) + mock-gateway(8787) + aiyan-ui(8899) |
| 2 | 浏览器开 `http://127.0.0.1:8011/home` | 门户加载；顶部状态条显示真实 /api/capabilities 字段 |
| 3 | `http://127.0.0.1:8899/` | 智衍·衡鉴加载；左侧导航末项「AI4S 驾驶舱 ⌬」可点击深链回 8011 |

## 依赖与版本
| 依赖 | 版本 | 校验命令 |
|---|---|---|
| Node.js | ≥20（实测 v24.17.0） | `node --version` |
| Python | ≥3.12（实测 3.14.6） | `python --version` |
| Python 包 | fastapi-starlette 系、requests、pytest（`requirements-dev.txt`） | `pip install -r requirements-dev.txt` |
| pnpm | 11.x（lockfile 固定） | `pnpm install --frozen-lockfile` |

## 环境变量（无 key 也能演示：诚实不可用路径）
| 变量 | 作用 | 缺省行为 |
|---|---|---|
| `ASTRA_PROVIDER` | atria / inkstone-desktop / s2 / mock | 未设且无 key → SOLVER_NOT_CONFIGURED 诚实终态 |
| `ASTRA_ATRIA_API_KEY` | Atria 凭据 | 仅服务端；禁止入库 |
| `ASTRA_ATRIA_ENDPOINT` | 默认 discovery-api | 白名单校验 |
| `ASTRA_ATRIA_REASONING_MODE` | off / hybrid / auto_expand | 默认 off |
| `ASTRA_DATA_ROOT` | 数据根（默认 var/astra） | 回放/协议日志落盘位置 |
| `ASTRA_PROTOCOL_SOURCE` | live / mock | mock 时协议观测走 8787 合成源并标注 synthetic |

## 验收项
- [x] 中文路径安装与运行（`D:\书生` 全链路通过；esbuild TEMP 需重定向见下）
- [x] 进程清理：start_demo.py Ctrl+C 统一 terminate 子进程
- [x] 无凭据启动不崩溃且诚实（SOLVER_NOT_CONFIGURED，不冒充模型结果）
- [x] 时间胶囊离线回放：release/replay-packages/ 四域 manifest + SHA256
- [x] BUILD_MANIFEST 校验通过（VERIFY_OK）
- [ ] 安装包形态（installer）——建设中，未验收

## 已知环境注意事项（非缺陷）
- 开发沙箱内：esbuild 需 `TEMP=<repo>\.tmp`；pnpm 需 `--store-dir <repo>\.pnpm-store`；TestClient loopback 测试 9 例环境性失败（正常环境通过）
