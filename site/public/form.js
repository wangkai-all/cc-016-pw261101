// 新建预约页的浏览器端脚本：线路联动、时段加载、动态装卸点
(function () {
  const routeSel = document.getElementById('f-route');
  const whSel = document.getElementById('f-warehouse');
  const dateInput = document.getElementById('f-date');
  const slotList = document.getElementById('slot-list');
  const stopsBox = document.getElementById('stops');
  const addStopBtn = document.getElementById('add-stop');
  const form = document.getElementById('appointment-form');
  const stopsJson = document.getElementById('stops-json');

  function showSessionExpired() {
    // 会话失效：跳回登录页
    window.location.href = '/login?expired=1';
  }

  async function fetchOptions(routeId, date) {
    let res;
    try {
      res = await fetch('/api/options?route_id=' + encodeURIComponent(routeId) + '&date=' + encodeURIComponent(date || ''));
    } catch (e) {
      return null;
    }
    if (res.status === 401) { showSessionExpired(); return null; }
    return res.json();
  }

  function renderSlots(slots, hasDate) {
    if (!hasDate) {
      slotList.innerHTML = '<span class="muted" id="slot-placeholder">请选择日期</span>';
    } else if (!slots || slots.length === 0) {
      slotList.innerHTML = '<span class="muted">该日期没有可用时段</span>';
    } else {
      slotList.innerHTML = slots.map(s => {
        const full = s.remaining <= 0;
        return `<label class="slot ${full ? 'full' : ''}">
          <input type="radio" name="slot_id" value="${s.id}" ${full ? 'disabled' : ''}
                 data-time-range="${s.time_range}" data-remaining="${s.remaining}">
          ${s.time_range}（剩余 ${s.remaining}）${full ? ' · 已满' : ''}
        </label>`;
      }).join('');
    }
  }

  // 线路变化：重载仓库（并按当前日期刷新时段）
  async function loadWarehouses() {
    const routeId = routeSel.value;
    whSel.innerHTML = '<option value="">加载中…</option>';
    whSel.disabled = true;
    slotList.innerHTML = '<span class="muted">加载中…</span>';
    if (!routeId) {
      whSel.innerHTML = '<option value="">请先选择线路</option>';
      slotList.innerHTML = '<span class="muted" id="slot-placeholder">尚未加载时段</span>';
      return;
    }
    const data = await fetchOptions(routeId, dateInput.value);
    if (!data) { slotList.innerHTML = '<span class="error-text">网络错误，请重试</span>'; return; }
    whSel.innerHTML = '<option value="">请选择仓库</option>' +
      data.warehouses.map(w => `<option value="${w.id}">${w.name}</option>`).join('');
    whSel.disabled = false;
    renderSlots(data.slots, !!dateInput.value);
  }

  // 日期变化：只刷新时段，保留已选仓库
  async function loadSlots() {
    const routeId = routeSel.value;
    if (!routeId) {
      slotList.innerHTML = '<span class="muted" id="slot-placeholder">请先选择线路</span>';
      return;
    }
    slotList.innerHTML = '<span class="muted">加载中…</span>';
    const data = await fetchOptions(routeId, dateInput.value);
    if (!data) { slotList.innerHTML = '<span class="error-text">网络错误，请重试</span>'; return; }
    renderSlots(data.slots, !!dateInput.value);
  }

  routeSel.addEventListener('change', loadWarehouses);
  dateInput.addEventListener('change', loadSlots);

  // ---- 动态装卸点 ----
  function renumber() {
    [...stopsBox.querySelectorAll('.stop-row')].forEach((row, i) => {
      row.querySelector('.stop-seq').textContent = String(i + 1);
    });
  }
  function addStop(kind, address) {
    const idx = stopsBox.querySelectorAll('.stop-row').length + 1;
    const div = document.createElement('div');
    div.className = 'stop-row';
    div.innerHTML = `
      <span class="stop-seq">${idx}</span>
      <select class="stop-kind">
        <option value="装">装</option>
        <option value="卸">卸</option>
      </select>
      <input class="stop-address" placeholder="装卸点地址" value="">
      <button type="button" class="linkbtn stop-remove">删除</button>`;
    div.querySelector('.stop-kind').value = kind || '装';
    if (address) div.querySelector('.stop-address').value = address;
    div.querySelector('.stop-remove').addEventListener('click', () => { div.remove(); renumber(); });
    stopsBox.appendChild(div);
    renumber();
  }
  addStopBtn.addEventListener('click', () => addStop());
  addStop(); // 默认一行

  // ---- 提交前：序列化装卸点 + 前端校验 ----
  form.addEventListener('submit', (ev) => {
    const stops = [...stopsBox.querySelectorAll('.stop-row')].map((row, i) => ({
      seq: i + 1,
      kind: row.querySelector('.stop-kind').value,
      address: row.querySelector('.stop-address').value.trim(),
    }));
    stopsJson.value = JSON.stringify(stops);

    const errs = [];
    const v = id => document.getElementById(id).value.trim();
    if (!v('f-serial')) errs.push('业务流水号必填');
    if (!routeSel.value) errs.push('请选择线路');
    if (!whSel.value) errs.push('请选择仓库');
    if (!v('f-date')) errs.push('请选择预约日期');
    if (!form.querySelector('input[name="slot_id"]:checked')) errs.push('请选择时段');
    if (!v('f-plate')) errs.push('车牌号必填');
    if (!v('f-driver')) errs.push('司机姓名必填');
    if (!/^1\d{10}$/.test(v('f-phone'))) errs.push('司机电话须为 11 位手机号');
    if (stops.length === 0) errs.push('至少一个装卸点');
    stops.forEach((s, i) => { if (!s.address) errs.push(`第 ${i + 1} 个装卸点地址为空`); });

    document.querySelectorAll('.client-error').forEach(e => e.remove());
    if (errs.length) {
      ev.preventDefault();
      const box = document.createElement('div');
      box.className = 'alert error client-error';
      box.id = 'client-errors';
      box.innerHTML = '<b>表单校验未通过：</b><ul>' + errs.map(e => `<li class="field-error">${e}</li>`).join('') + '</ul>';
      form.prepend(box);
      box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
})();
