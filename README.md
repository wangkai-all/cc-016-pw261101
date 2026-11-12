# 运输预约逐条录入系统（pointwise-delivery）

把 CSV 里的运输预约**逐条填进网页表单**：本地预约网站 + Playwright 真实页面操作 + React 操作台 + SQLite 进度持久化。录入到哪一条、卡在哪个字段，操作台上都看得见。

## 组成

| 模块 | 位置 | 说明 |
|---|---|---|
| 预约网站（被录入方） | `site/` | Express + `node:sqlite`，服务端渲染。登录、线路→仓库/时段联动、多装卸点、确认页、列表查流水号、演示开关 |
| 录入服务 | `importer/` | TypeScript + Playwright。读 CSV → 逐条驱动浏览器填表 → 容错/查重/断点恢复，进度存 `data/importer.sqlite` |
| React 操作台 | `web/` | Vite 构建，由录入服务托管。每条记录的校验、页面操作时间线、最终回执、CSV vs 回执逐字段核对 |

## 启动

```bash
npm install
npm run build:web          # 构建 React 操作台（web/dist）
npm run site               # 预约网站  http://localhost:4300
npm run importer           # 录入服务  http://localhost:4301（操作台入口）
npm run sample:csv         # 重新生成 samples/appointments.csv（日期跟随“明天”滚动）
```

演示账号：`demo / demo123`。操作台里导入 `samples/appointments.csv` → 开始。

> 本机特殊环境（无 root、无系统浏览器库）的适配已做在仓库里：浏览器二进制在
> `.playwright-browsers/`，系统库解包在 `.syslibs/`，`importer/src/env.ts` 自动注入
> `PLAYWRIGHT_BROWSERS_PATH` / `LD_LIBRARY_PATH` / `FONTCONFIG_FILE`。
> 在正常机器上只需 `npx playwright install --with-deps chromium`，这些目录不需要。

## CSV 格式

```csv
serial,route,warehouse,date,slot,plate,driver,phone,stops,remark
BK20261112-001,华东干线,上海青浦仓,2026-11-12,13:00-15:00,沪A12345,张伟,13800001111,装:上海市青浦区1号库|卸:苏州市工业园区2号门,加急
```

- 一行一条预约；`stops` 列用 `|` 分隔多个装卸点，`装:地址` / `卸:地址`，**书写顺序即录入顺序**
- `date` 必须落在网站的可约窗口内（种子数据为明天起 7 天），`slot` 形如 `08:00-10:00`

## 录入规则（已实现并逐条验证）

- **唯一流水号**：网站侧 `serial` 有 UNIQUE 约束兜底；录入服务在“进程中断恢复”和“重复导入”时会先按流水号查列表再决定是否提交
- **线路联动**：选完线路才加载仓库与时段（Playwright 等真实 DOM 变化，不调网站内部接口）
- **失败不扩散**：字段不合规（本地校验拦截）、时段已满 → 该条记错误，其他预约继续；**不自动替换日期或仓库**
- **登录过期**：填到一半被踢回登录页 → 暂停本条 → 重新登录 → 重填本条，批次不断
- **提交后连接断开**：先到预约列表按流水号查结果，确认没创建成功才重新提交
- **不重复**：重复导入同一 CSV、进程 SIGKILL 后重启恢复，网站侧都不会多出预约（已验证：`GROUP BY serial HAVING COUNT(*)>1` 为空）

## 演示开关（网站 `/demo` 页，off / once / on）

| 开关 | 效果 | 录入服务的应对 |
|---|---|---|
| 提交前容量变化 | 提交瞬间时段被约满，返回“时段已满” | 该条记错误，继续后续预约 |
| 填到一半登录失效 | 表单联动加载时会话被注销，跳回登录页 | 重新登录，重填当前条，批次不断 |
| 创建成功却没打开确认页 | 预约已落库，但响应半路 502 断掉 | 查列表按流水号确认已创建 → 不重复提交，回执照抓 |

## 操作台

- 批次列表：成功/失败/重复/待处理计数，运行状态
- 记录表：每条的流水号、状态、错误、**回执链接**（点开 = 网站对应预约详情页，可逐个核对实际填进去的值）
- 展开每条：**页面操作时间线**（登录/填写/选择/提交/查重/恢复/回执）+ **CSV 期望 vs 网站回执实际值**逐字段核对表
- 失败截图存 `data/screenshots/`

## 数据

- `data/site.sqlite` — 网站数据（预约、时段容量、会话、演示开关）。删掉即重新播种
- `data/importer.sqlite` — 批次、记录状态、操作事件。进程重启时把 `running` 记录恢复为待处理并标记“提交前先查列表”
