// 服务端渲染的 HTML 模板（目标预约网站）
export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function layout(title: string, body: string, user?: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · 运输预约平台</title>
<link rel="stylesheet" href="/public/style.css">
</head>
<body data-page="${escapeHtml(title)}">
<header class="topbar">
  <a class="brand" href="/">运输预约平台</a>
  <nav>
    <a href="/appointments">预约列表</a>
    <a href="/appointments/new">新建预约</a>
    <a href="/demo" target="_blank">演示开关</a>
    ${user ? `<span class="user">当前用户：${escapeHtml(user)}</span>
    <form method="post" action="/logout" style="display:inline"><button class="linkbtn" type="submit">退出登录</button></form>` : ''}
  </nav>
</header>
<main class="container">
${body}
</main>
</body>
</html>`;
}

export function loginPage(error = '', expired = false): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>登录 · 运输预约平台</title>
<link rel="stylesheet" href="/public/style.css">
</head>
<body>
<main class="container narrow">
  <h1>登录</h1>
  ${expired ? '<div class="alert warn" id="login-expired">登录已过期，请重新登录</div>' : ''}
  ${error ? `<div class="alert error" id="login-error">${escapeHtml(error)}</div>` : ''}
  <form method="post" action="/login" class="card form">
    <label>用户名 <input name="username" id="username" autocomplete="username"></label>
    <label>密码 <input name="password" id="password" type="password" autocomplete="current-password"></label>
    <button type="submit" id="login-submit" class="primary">登录</button>
    <p class="muted">演示账号：demo / demo123</p>
  </form>
</main>
</body>
</html>`;
}

export interface AppointmentRow {
  id: number; serial: string; route: string; warehouse: string;
  date: string; time_range: string; driver: string; plate: string; created_at: string;
}

export function listPage(rows: AppointmentRow[], q: string, user: string): string {
  const trs = rows.map(r => `
    <tr data-serial="${escapeHtml(r.serial)}">
      <td><a class="serial-link" href="/appointments/${r.id}">${escapeHtml(r.serial)}</a></td>
      <td>${escapeHtml(r.route)}</td>
      <td>${escapeHtml(r.warehouse)}</td>
      <td>${escapeHtml(r.date)}</td>
      <td>${escapeHtml(r.time_range)}</td>
      <td>${escapeHtml(r.driver)} / ${escapeHtml(r.plate)}</td>
      <td>${escapeHtml(r.created_at)}</td>
    </tr>`).join('');
  return layout('预约列表', `
  <h1>预约列表</h1>
  <form method="get" action="/appointments" class="searchbar" id="search-form">
    <input name="q" id="search-input" placeholder="按业务流水号搜索" value="${escapeHtml(q)}">
    <button type="submit" id="search-submit" class="primary">搜索</button>
  </form>
  ${q ? `<p class="muted" id="search-summary">流水号 “${escapeHtml(q)}” 共 ${rows.length} 条结果</p>` : ''}
  <table class="table" id="appointments-table">
    <thead><tr><th>业务流水号</th><th>线路</th><th>仓库</th><th>日期</th><th>时段</th><th>司机/车牌</th><th>创建时间</th></tr></thead>
    <tbody>${trs || '<tr><td colspan="7" class="muted" id="no-result">暂无数据</td></tr>'}</tbody>
  </table>`, user);
}

export interface RouteOpt { id: number; name: string }

export function newPage(routes: RouteOpt[], user: string, errors: string[] = [], old: Record<string, string> = {}): string {
  const opts = routes.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
  const errHtml = errors.length
    ? `<div class="alert error" id="form-errors"><b>提交失败：</b><ul>${errors.map(e => `<li class="field-error">${escapeHtml(e)}</li>`).join('')}</ul></div>`
    : '';
  return layout('新建预约', `
  <h1>新建运输预约</h1>
  ${errHtml}
  <form method="post" action="/appointments" class="card form" id="appointment-form" novalidate>
    <div class="grid2">
      <label>业务流水号 *
        <input name="serial" id="f-serial" value="${escapeHtml(old.serial ?? '')}" placeholder="如 BK20261112-001">
      </label>
      <label>线路 *
        <select name="route_id" id="f-route">
          <option value="">请选择线路</option>${opts}
        </select>
      </label>
      <label>仓库 * <span class="hint">（先选线路）</span>
        <select name="warehouse_id" id="f-warehouse" disabled>
          <option value="">请先选择线路</option>
        </select>
      </label>
      <label>预约日期 *
        <input name="date" id="f-date" type="date" value="${escapeHtml(old.date ?? '')}">
      </label>
    </div>
    <fieldset id="slot-fieldset">
      <legend>时段 * <span class="hint">（选择线路与日期后加载）</span></legend>
      <div id="slot-list" class="slots"><span class="muted" id="slot-placeholder">尚未加载时段</span></div>
    </fieldset>
    <div class="grid2">
      <label>车牌号 * <input name="plate" id="f-plate" value="${escapeHtml(old.plate ?? '')}" placeholder="沪A12345"></label>
      <label>司机姓名 * <input name="driver" id="f-driver" value="${escapeHtml(old.driver ?? '')}"></label>
      <label>司机电话 * <input name="phone" id="f-phone" value="${escapeHtml(old.phone ?? '')}" placeholder="11 位手机号"></label>
      <label>备注 <input name="remark" id="f-remark" value="${escapeHtml(old.remark ?? '')}"></label>
    </div>
    <fieldset>
      <legend>装卸点（按顺序）*</legend>
      <div id="stops"></div>
      <button type="button" id="add-stop" class="secondary">+ 添加装卸点</button>
      <input type="hidden" name="stops_json" id="stops-json">
    </fieldset>
    <div class="actions">
      <button type="submit" id="submit-btn" class="primary">提交预约</button>
    </div>
  </form>
  <script src="/public/form.js"></script>`, user);
}

export interface StopRow { seq: number; kind: string; address: string }
export interface DetailData {
  id: number; serial: string; route: string; warehouse: string; date: string;
  time_range: string; plate: string; driver: string; phone: string; remark: string;
  created_at: string; stops: StopRow[];
}

function detailTable(d: DetailData): string {
  const stops = d.stops.map(s => `
    <tr class="stop-row" data-seq="${s.seq}">
      <td>${s.seq}</td><td>${escapeHtml(s.kind)}</td><td>${escapeHtml(s.address)}</td>
    </tr>`).join('');
  return `
  <dl class="detail" id="appointment-detail" data-appointment-id="${d.id}" data-serial="${escapeHtml(d.serial)}">
    <div><dt>业务流水号</dt><dd data-field="serial">${escapeHtml(d.serial)}</dd></div>
    <div><dt>线路</dt><dd data-field="route">${escapeHtml(d.route)}</dd></div>
    <div><dt>仓库</dt><dd data-field="warehouse">${escapeHtml(d.warehouse)}</dd></div>
    <div><dt>预约日期</dt><dd data-field="date">${escapeHtml(d.date)}</dd></div>
    <div><dt>时段</dt><dd data-field="time_range">${escapeHtml(d.time_range)}</dd></div>
    <div><dt>车牌号</dt><dd data-field="plate">${escapeHtml(d.plate)}</dd></div>
    <div><dt>司机姓名</dt><dd data-field="driver">${escapeHtml(d.driver)}</dd></div>
    <div><dt>司机电话</dt><dd data-field="phone">${escapeHtml(d.phone)}</dd></div>
    <div><dt>备注</dt><dd data-field="remark">${escapeHtml(d.remark)}</dd></div>
    <div><dt>创建时间</dt><dd data-field="created_at">${escapeHtml(d.created_at)}</dd></div>
  </dl>
  <h3>装卸点（共 ${d.stops.length} 个，按顺序）</h3>
  <table class="table" id="stops-table">
    <thead><tr><th>顺序</th><th>类型</th><th>地址</th></tr></thead>
    <tbody>${stops}</tbody>
  </table>`;
}

export function confirmPage(d: DetailData, user: string): string {
  return layout('预约确认', `
  <div class="alert success" id="confirm-banner">✔ 预约创建成功</div>
  <h1>预约确认页</h1>
  ${detailTable(d)}
  <p><a class="primary btn" id="goto-detail" href="/appointments/${d.id}">查看预约详情</a>
     <a class="btn" href="/appointments/new">再录一条</a></p>`, user);
}

export function detailPage(d: DetailData, user: string): string {
  return layout(`预约详情 ${d.serial}`, `
  <h1>预约详情</h1>
  ${detailTable(d)}
  <p><a class="btn" href="/appointments">返回列表</a></p>`, user);
}

export function errorPage(title: string, message: string, user: string, status = 400): string {
  return layout(title, `
  <div class="alert error" id="error-banner" data-status="${status}">${escapeHtml(title)}</div>
  <p id="error-message">${escapeHtml(message)}</p>
  <p><a class="btn" href="/appointments/new">返回新建预约</a> <a class="btn" href="/appointments">预约列表</a></p>`, user);
}

export function demoPage(switches: Record<string, string>, user?: string): string {
  const items: [string, string, string][] = [
    ['sw_capacity_shrink', '提交前容量变化', '提交瞬间目标时段被他人约满，本次提交返回“时段已满”'],
    ['sw_session_kill', '填到一半登录失效', '表单填到一半（加载线路选项时）会话被服务端注销，跳回登录页'],
    ['sw_confirm_drop', '创建成功却没打开确认页', '预约已写入数据库，但响应连接被掐断，浏览器拿不到确认页'],
  ];
  const cards = items.map(([key, label, desc]) => {
    const cur = switches[key] ?? 'off';
    const radio = (v: string, text: string) =>
      `<label class="radio"><input type="radio" name="${key}" value="${v}" ${cur === v ? 'checked' : ''}> ${text}</label>`;
    return `<fieldset class="card switch" data-switch="${key}">
      <legend><b>${label}</b></legend>
      <p class="muted">${desc}</p>
      ${radio('off', '关闭')}
      ${radio('once', '触发一次后自动关闭')}
      ${radio('on', '一直生效')}
    </fieldset>`;
  }).join('');
  return layout('演示开关', `
  <h1>演示开关</h1>
  <p class="muted">用于演示录入服务的容错能力。改动即时生效，无需重启。</p>
  <form method="post" action="/demo" id="demo-form">
    ${cards}
    <button type="submit" class="primary" id="demo-save">保存开关</button>
    <span class="muted" id="demo-saved"></span>
  </form>
  <h2>当前状态</h2>
  <pre id="switch-state">${escapeHtml(JSON.stringify(switches, null, 2))}</pre>`, user);
}
