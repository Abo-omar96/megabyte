/* Accounting corrections and safe synchronisation layer. */
(() => {
  const TYPES = ['accounts', 'snapshots', 'customers', 'capitalLogs', 'expenses'];
  const money = value => Math.round((Number(value) || 0) * 100) / 100;
  const stamp = () => new Date().toISOString();
  const id = prefix => `${prefix}_${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
  const localDateTime = (d = new Date()) => {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const validDate = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '') && !Number.isNaN(new Date(value).valueOf());
  const byDate = (a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id));
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const zero = () => ({ accounts: defaultAccounts.map(x => ({...x, updatedAt: stamp()})), snapshots: [], customers: [], capitalLogs: [], expenses: [], deleted: {} });
  function normalise(input) {
    const state = input && typeof input === 'object' ? structuredClone(input) : zero();
    TYPES.forEach(key => { if (!Array.isArray(state[key])) state[key] = key === 'accounts' ? defaultAccounts.map(x => ({...x})) : []; });
    if (!state.accounts.length) state.accounts = defaultAccounts.map(x => ({...x}));
    if (!state.deleted || typeof state.deleted !== 'object') state.deleted = {};
    TYPES.forEach(key => { if (!Array.isArray(state.deleted[key])) state.deleted[key] = []; });
    state.snapshots.sort(byDate); state.customers.sort(byDate); state.capitalLogs.sort(byDate); state.expenses.sort(byDate);
    return state;
  }
  function mergeRows(a = [], b = [], deleted = []) {
    const gone = new Set(deleted); const map = new Map();
    [...a, ...b].forEach(row => {
      if (!row || !row.id || gone.has(row.id)) return;
      const old = map.get(row.id);
      if (!old || String(row.updatedAt || '') >= String(old.updatedAt || '')) map.set(row.id, row);
    });
    return [...map.values()];
  }
  window.mergeStates = (remote, local) => {
    const r = normalise(remote), l = normalise(local), out = { deleted: {} };
    TYPES.forEach(key => {
      out.deleted[key] = [...new Set([...(r.deleted[key] || []), ...(l.deleted[key] || [])])];
      out[key] = mergeRows(r[key], l[key], out.deleted[key]);
    });
    return normalise(out);
  };
  window.applyState = (data, repaint = true) => {
    // Merge incoming state so a simultaneous edit on this device is not erased by a listener update.
    window.appData = window.mergeStates(data, window.appData);
    localStorage.setItem('app_accounting_db', JSON.stringify(window.appData));
    if (repaint) renderAllViews();
  };
  const persist = () => { window.appData = normalise(window.appData); localStorage.setItem('app_accounting_db', JSON.stringify(window.appData)); renderAllViews(); window.pushDataToCloud?.(); };
  const addTombstone = (collection, recordId) => { const set = new Set(window.appData.deleted[collection] || []); set.add(recordId); window.appData.deleted[collection] = [...set]; };
  const accountsForReports = () => window.appData.accounts.slice();
  const accountBalance = snap => Object.values(snap?.balances || {}).reduce((sum, amount) => money(sum + money(amount)), 0);
  const customerNetAt = date => window.appData.customers.filter(x => x.date <= date).reduce((sum, x) => money(sum + (x.type === 'us' ? money(x.amount) : x.type === 'them' ? -money(x.amount) : x.type === 'repayment' ? -money(x.amount) : money(x.amount))), 0);
  const capitalAt = date => window.appData.capitalLogs.filter(x => x.date <= date).reduce((sum, x) => money(sum + (x.type === 'add' ? money(x.amount) : -money(x.amount))), 0);
  const operatingNetAssets = snap => money(accountBalance(snap) + customerNetAt(snap.date));
  function setSyncStatus(ok, text) {
    const dot = document.getElementById('syncDot'), label = document.getElementById('syncText'), box = document.getElementById('syncStatus');
    if (!dot || !label || !box) return;
    dot.className = `w-2 h-2 rounded-full ${ok ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`;
    label.textContent = text; box.className = `flex items-center space-x-1.5 space-x-reverse text-xs px-3 py-1.5 rounded-lg ${ok ? 'bg-emerald-950/60 border border-emerald-500/40 text-emerald-300' : 'bg-red-950/60 border border-red-500/40 text-red-300'}`;
  }
  window.setSyncStatus = setSyncStatus;
  window.connectCloudRoom = () => {
    const field = document.getElementById('roomIdInput'); const room = field.value.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (!room) return alert('استخدم رمزاً من حروف أو أرقام أو شرطة فقط (حتى 64 حرفاً).');
    localStorage.setItem('app_sync_room_id', room); field.value = room; window.initCloudSync?.();
  };
  window.saveAccountConfig = e => {
    e.preventDefault(); const edit = document.getElementById('accEditId').value, name = document.getElementById('accName').value.trim();
    if (!name) return;
    const item = { id: edit || id('acc'), name, type: document.getElementById('accType').value, status: document.getElementById('accStatus').value, updatedAt: stamp() };
    const n = window.appData.accounts.findIndex(x => x.id === edit); n < 0 ? window.appData.accounts.push(item) : window.appData.accounts[n] = {...window.appData.accounts[n], ...item};
    resetAccountForm(); persist();
  };
  window.deleteAccount = recordId => {
    const used = window.appData.snapshots.some(s => Object.prototype.hasOwnProperty.call(s.balances || {}, recordId));
    const item = window.appData.accounts.find(x => x.id === recordId); if (!item) return;
    if (!confirm(used ? 'الحساب مستخدم في لقطات سابقة؛ سيُؤرشف بدلاً من حذفه لحماية التقارير. متابعة؟' : 'تأكيد أرشفة الحساب؟')) return;
    item.status = 'inactive'; item.updatedAt = stamp(); persist();
  };
  window.saveSnapshot = e => {
    e.preventDefault(); const date = document.getElementById('snapDate').value;
    if (!validDate(date)) return alert('أدخل تاريخاً ووقتاً صحيحين.');
    if (window.appData.snapshots.some(s => s.date === date)) return alert('توجد لقطة بهذا التاريخ والوقت؛ اختر وقتاً مختلفاً.');
    const balances = {}; window.appData.accounts.filter(a => a.status === 'active').forEach(a => { const v = Number(document.getElementById('snap_acc_' + a.id)?.value); balances[a.id] = Number.isFinite(v) && v >= 0 ? money(v) : 0; });
    window.appData.snapshots.push({id: id('snap'), date, balances, updatedAt: stamp()}); persist(); document.getElementById('snapDate').value = localDateTime(); alert('تم حفظ لقطة الرصيد.');
  };
  window.deleteSnapshot = recordId => { if (confirm('تأكيد حذف لقطة الرصيد؟')) { addTombstone('snapshots', recordId); window.appData.snapshots = window.appData.snapshots.filter(x => x.id !== recordId); persist(); } };
  window.saveCustomerRecord = e => {
    e.preventDefault(); const name = document.getElementById('custName').value.trim(), date = document.getElementById('custDate').value, type = document.getElementById('custType').value, amount = money(document.getElementById('custAmount').value);
    if (!name || !validDate(date) || amount <= 0) return alert('أكمل الاسم والتاريخ والمبلغ الصحيح.');
    const before = window.appData.customers.filter(x => x.name === name && x.date <= date); const balance = before.reduce((n,x) => money(n + (x.type === 'us' ? x.amount : x.type === 'them' ? -x.amount : x.type === 'repayment' ? -x.amount : x.amount)), 0);
    if (type === 'repayment' && (balance <= 0 || amount > balance)) return alert('التسديد أكبر من دين العميل المسجل حتى هذا التاريخ.');
    if (type === 'refund' && (balance >= 0 || amount > Math.abs(balance))) return alert('السداد أكبر من المبلغ المستحق للعميل حتى هذا التاريخ.');
    window.appData.customers.push({id:id('cust'),name,date,type,amount,updatedAt:stamp()}); persist(); document.getElementById('custAmount').value=''; alert('تم تسجيل حركة العميل.');
  };
  window.deleteCustomerRecord = recordId => { if (confirm('تأكيد حذف حركة العميل؟')) { addTombstone('customers',recordId); window.appData.customers=window.appData.customers.filter(x=>x.id!==recordId); persist(); } };
  window.saveExpense = e => { e.preventDefault(); const title=document.getElementById('expTitle').value.trim(), date=document.getElementById('expDate').value, amount=money(document.getElementById('expAmount').value); if(!title||!validDate(date)||amount<=0)return alert('أكمل بيانات المصروف.'); window.appData.expenses.push({id:id('exp'),title,date,amount,updatedAt:stamp()}); persist(); document.getElementById('expTitle').value=''; document.getElementById('expAmount').value=''; };
  window.deleteExpense = recordId => { if(confirm('تأكيد حذف المصروف؟')) { addTombstone('expenses',recordId); window.appData.expenses=window.appData.expenses.filter(x=>x.id!==recordId); persist(); } };
  window.saveCapitalTransaction = e => { e.preventDefault(); const investor=document.getElementById('capInvestor').value.trim(), type=document.getElementById('capType').value, date=document.getElementById('capDate').value, amount=money(document.getElementById('capAmount').value); if(!investor||!validDate(date)||amount<=0)return alert('أكمل بيانات رأس المال.'); const available=window.appData.capitalLogs.filter(x=>x.investor===investor&&x.date<=date).reduce((n,x)=>money(n+(x.type==='add'?x.amount:-x.amount)),0); if(type==='withdraw'&&amount>available)return alert('السحب أكبر من رأس المال المتاح للمستثمر في هذا التاريخ.'); window.appData.capitalLogs.push({id:id('cap'),investor,type,date,amount,updatedAt:stamp()}); persist(); document.getElementById('capAmount').value=''; };
  window.deleteCapitalLog = recordId => { if(confirm('تأكيد حذف حركة رأس المال؟')) { addTombstone('capitalLogs',recordId); window.appData.capitalLogs=window.appData.capitalLogs.filter(x=>x.id!==recordId); persist(); } };
  window.getCustomersBalancesAtDate = date => { const net=customerNetAt(date); return {totalUs:Math.max(0,net),totalThem:Math.max(0,-net),netCust:net}; };
  window.getCustomersBalancesMap = () => {
    const map = {};
    window.appData.customers.forEach(x => { map[x.name] = money((map[x.name] || 0) + (x.type === 'us' ? x.amount : x.type === 'them' ? -x.amount : x.type === 'repayment' ? -x.amount : x.amount)); });
    return map;
  };
  window.getTotalCapitalAtDate = capitalAt;
  window.formatDateEn = value => validDate(value) ? new Intl.DateTimeFormat('en-GB',{dateStyle:'short',timeStyle:'short'}).format(new Date(value)) : '';
  window.renderDynamicSnapshotInputs = () => { const c=document.getElementById('dynamicSnapshotInputs'); if(!c)return; c.innerHTML=window.appData.accounts.filter(a=>a.status==='active').map(a=>`<div><label class="block text-xs font-semibold text-slate-300 mb-1">${escapeHtml(a.name)}</label><input type="number" step="0.01" min="0" id="snap_acc_${a.id}" placeholder="0.00" class="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white font-mono"></div>`).join(''); };
  window.renderSnapshotsTable = () => { const header=document.getElementById('snapshotsTableHeader'), body=document.getElementById('snapshotsTableBody'); if(!header||!body)return; const acc=accountsForReports(); header.innerHTML=`<tr><th class="p-3">التاريخ والوقت</th>${acc.map(a=>`<th class="p-3">${escapeHtml(a.name)}</th>`).join('')}<th class="p-3 font-bold text-emerald-400">صافي الأصول التشغيلية</th><th class="p-3 font-bold text-brand-400">تغير الأصول</th><th class="p-3 no-print">حذف</th></tr>`; let prev=null; body.innerHTML=window.appData.snapshots.map(s=>{const total=operatingNetAssets(s),change=prev===null?'بداية الحسابات':formatNum(money(total-prev)); const sign=prev!==null&&total>=prev?'+':'';prev=total;return `<tr class="hover:bg-slate-800/50"><td class="p-3 font-mono text-xs text-slate-400">${formatDateEn(s.date)}</td>${acc.map(a=>`<td class="p-3 font-mono">${formatNum(money(s.balances?.[a.id]))}</td>`).join('')}<td class="p-3 font-bold font-mono text-emerald-400">${formatNum(total)} ج.م</td><td class="p-3 font-mono">${sign}${change}</td><td class="p-3 no-print"><button onclick="deleteSnapshot('${s.id}')" class="text-red-400"><i class="fa-solid fa-trash"></i></button></td></tr>`;}).join(''); };
  window.updateDashboardCards = () => { const last=window.appData.snapshots.at(-1), assets=last?operatingNetAssets(last):0, net=customerNetAt('9999-12-31T23:59'), cap=capitalAt('9999-12-31T23:59'); document.getElementById('totalAssetsCard').innerHTML=`${formatNum(assets)} <span class="text-xs text-slate-400 font-normal">ج.م</span>`; document.getElementById('totalCapitalCard').innerHTML=`${formatNum(cap)} <span class="text-xs text-slate-400 font-normal">ج.م</span>`; document.getElementById('netCustomersCard').innerHTML=`${formatNum(net)} <span class="text-xs text-slate-400 font-normal">ج.م</span>`; document.getElementById('customersUsCard').textContent=formatNum(Math.max(net,0))+' ج.م'; document.getElementById('customersThemCard').textContent=formatNum(Math.max(-net,0))+' ج.م'; };
  window.generateProfitReport = () => { const ss=window.appData.snapshots, explanation=document.getElementById('reportFormulaExplanation'), out=document.getElementById('investorProfitBody'); if(ss.length<2){if(explanation)explanation.innerHTML='<p class="text-amber-400">يلزم تسجيل لقطتي رصيد على الأقل.</p>';if(out)out.innerHTML='';return;} const startValue=document.getElementById('reportStartDate').value,endValue=document.getElementById('reportEndDate').value; const start=startValue?[...ss].reverse().find(s=>s.date<=startValue):ss[0],end=endValue?[...ss].reverse().find(s=>s.date<=endValue):ss.at(-1); if(!start||!end||end.date<=start.date){if(explanation)explanation.innerHTML='<p class="text-red-400">اختر فترة تحتوي على لقطتين مرتبتين زمنياً.</p>';return;} const additions=window.appData.capitalLogs.filter(x=>x.date>start.date&&x.date<=end.date&&x.type==='add').reduce((n,x)=>money(n+x.amount),0),withdrawals=window.appData.capitalLogs.filter(x=>x.date>start.date&&x.date<=end.date&&x.type==='withdraw').reduce((n,x)=>money(n+x.amount),0),delta=money(operatingNetAssets(end)-operatingNetAssets(start)),profit=money(delta-additions+withdrawals); document.getElementById('calculatedProfitCard').innerHTML=`${formatNum(profit)} <span class="text-xs text-slate-400 font-normal">ج.م</span>`; if(explanation)explanation.innerHTML=`<p>تغير صافي الأصول التشغيلية: <strong class="font-mono">${formatNum(delta)} ج.م</strong></p><p>الإضافات الرأسمالية: <strong class="font-mono">-${formatNum(additions)} ج.م</strong> | المسحوبات: <strong class="font-mono">+${formatNum(withdrawals)} ج.م</strong></p><p class="text-brand-400 font-bold">صافي الربح القابل للتوزيع: ${formatNum(profit)} ج.م</p><p class="text-slate-500">المصروفات لا تُخصم مرة أخرى لأنها تظهر في رصيد الصناديق عند تسجيلها.</p>`; const map={}; window.appData.capitalLogs.filter(x=>x.date<=end.date).forEach(x=>{const d=map[x.investor] ||= {base:0,add:0,withdraw:0}; if(x.date<=start.date)d.base=money(d.base+(x.type==='add'?x.amount:-x.amount)); else if(x.type==='add')d.add=money(d.add+x.amount);else d.withdraw=money(d.withdraw+x.amount);}); const total=Object.values(map).reduce((n,d)=>money(n+Math.max(0,money(d.base+d.add-d.withdraw))),0); if(out)out.innerHTML=Object.entries(map).map(([name,d])=>{const effective=Math.max(0,money(d.base+d.add-d.withdraw)),ratio=total?effective/total:0;return `<tr><td class="p-3 font-semibold text-white">${escapeHtml(name)}</td><td class="p-3 font-mono">${formatNum(d.base)}</td><td class="p-3 font-mono text-blue-400">+${formatNum(d.add)}</td><td class="p-3 font-mono text-red-400">-${formatNum(d.withdraw)}</td><td class="p-3 font-mono font-bold">${formatNum(effective)}</td><td class="p-3 font-mono text-indigo-400">${(ratio*100).toFixed(2)}%</td><td class="p-3 font-mono font-bold text-brand-400">${formatNum(money(profit*ratio))} ج.م</td></tr>`;}).join(''); };
  window.onload = () => { window.appData=normalise(window.appData); ['snapDate','custDate','expDate','capDate'].forEach(key=>{const el=document.getElementById(key);if(el)el.value=localDateTime();}); renderAllViews(); window.initCloudSync?.(); };
})();
