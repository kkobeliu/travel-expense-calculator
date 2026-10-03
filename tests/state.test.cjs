const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const vue = readFileSync(process.argv[2], 'utf8');
const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];

function boot(saved, failSave = false) {
    const store = new Map(saved ? [['travel-expense-calculator:v1', saved]] : []);
    const alerts = [];
    const ctx = vm.createContext({ console, setTimeout, clearTimeout, Blob, URL,
        alert: text => alerts.push(text), confirm: () => true,
        localStorage: {
            getItem: key => store.get(key) || null,
            setItem: (key, value) => { if (failSave) throw Error('quota'); store.set(key, value); }
        }
    });
    vm.runInContext(vue, ctx);
    ctx.Vue = { ...ctx.Vue, createApp: options => ({ mount: () => { ctx.app = options.setup(); } }) };
    vm.runInContext(source, ctx);
    return { app: ctx.app, store, alerts, tick: () => ctx.Vue.nextTick() };
}

(async () => {
    const env = boot();
    const a = env.app;
    a.loadDemoData();
    assert.equal(a.expenses.value.length, 2);
    a.currentGroup.value = '武陵'; a.handleGroupChange();
    assert.equal(a.expenses.value.length, 0);
    a.currentGroup.value = '大鎮'; a.handleGroupChange();
    assert.equal(a.expenses.value.length, 2, 'switching preserves records');
    a.deleteMember('小狗');
    assert(a.currentMembers.value.includes('小狗'), 'payer/participant cannot be deleted');
    a.newGroupName.value = '測試旅行'; a.addGroup();
    a.newMemberName.value = 'Alice'; a.addMember();
    a.newMemberName.value = 'Bob'; a.addMember();
    a.newMemberName.value = 'Bob'; a.addMember();
    assert.equal(a.currentMembers.value.length, 2, 'duplicates rejected');
    a.deleteMember('Bob');
    assert.equal(a.currentMembers.value.length, 1);
    assert.equal(a.expense.value.participants.length, 1);
    a.expense.value.title = '晚餐'; a.expense.value.amount = 120;
    a.addExpense();
    assert.equal(a.expenses.value.length, 1);
    a.expense.value.title = '無效金額'; a.expense.value.amount = Infinity;
    a.addExpense();
    assert.equal(a.expenses.value.length, 1);
    await env.tick();
    const saved = env.store.get('travel-expense-calculator:v1');
    assert(saved, 'deep changes auto-save');
    const restored = boot(saved).app;
    assert.equal(restored.currentGroup.value, '測試旅行');
    assert.equal(restored.expenses.value[0].amount, 120);
    assert.equal(restored.expense.value.payer, 'Alice');
    const changeCount = (field, value) => a.updateFamilyCount('Alice', field, { target: { value: String(value) } });
    changeCount('adults', 2); changeCount('children', 3);
    assert.equal(a.currentHeadcount.value.total, 5);
    for (const invalidCount of [-1, 1.5, '', 1000, 'NaN']) changeCount('children', invalidCount);
    assert.equal(a.currentHeadcount.value.children, 3, 'invalid counts rejected');
    await env.tick();
    const familyBackup = env.store.get('travel-expense-calculator:v1');
    assert.equal(boot(familyBackup).app.currentHeadcount.value.total, 5, 'family counts survive reload');
    a.currentGroup.value = '大鎮'; a.handleGroupChange();
    assert.equal(a.currentHeadcount.value.total, 7, 'counts isolated per group');
    a.currentGroup.value = '測試旅行'; a.handleGroupChange();
    assert.equal(a.currentHeadcount.value.total, 5);
    const legacy = JSON.parse(saved); legacy.version = 1; delete legacy.familySizes;
    assert.equal(boot(JSON.stringify(legacy)).app.currentHeadcount.value.adults, 1, 'legacy backup migrates');
    const fileEvent = text => ({ target: { value: 'backup.json', files: [{ size: text.length, text: async () => text }] } });
    const invalidFamily = JSON.parse(familyBackup);
    invalidFamily.familySizes['測試旅行'].Alice.children = -1;
    await a.importBackup(fileEvent(JSON.stringify(invalidFamily)));
    assert.equal(a.currentHeadcount.value.total, 5, 'invalid family import leaves data intact');
    await a.importBackup(fileEvent(familyBackup));
    assert.equal(a.currentHeadcount.value.total, 5, 'family counts restored from backup');
    changeCount('children', 0); changeCount('adults', 0);
    assert.equal(a.currentHeadcount.value.adults, 2, 'zero-person family rejected');
    const before = JSON.stringify(a.builtInGroups.value);
    await a.importBackup(fileEvent('{"version":1,"groups":{},"expenses":{},"currentGroup":"unknown"}'));
    assert.equal(JSON.stringify(a.builtInGroups.value), before, 'invalid backup leaves data intact');
    const invalid = JSON.parse(saved);
    invalid.expenses['測試旅行'][0].participants = [];
    await a.importBackup(fileEvent(JSON.stringify(invalid)));
    assert.equal(a.expenses.value.length, 1);
    a.deleteGroup();
    assert(!Object.hasOwn(a.builtInGroups.value, '測試旅行'));
    await a.importBackup(fileEvent(saved));
    assert.equal(a.currentGroup.value, '測試旅行', 'valid backup restores groups and selection');
    assert.equal(a.expenses.value.length, 1);
    while (a.currentGroup.value) a.deleteGroup();
    assert.equal(a.currentMembers.value.length, 0);
    assert.equal(a.currentHeadcount.value.total, 0);
    assert.equal(Object.keys(a.familySizes.value).length, 0);
    assert.equal(a.expense.value.payer, '');
    await env.tick();
    assert.equal(boot(env.store.get('travel-expense-calculator:v1')).app.currentGroup.value, '');
    a.newGroupName.value = '__proto__'; a.addGroup();
    assert.equal(a.currentGroup.value, '');
    a.newGroupName.value = '重新出發'; a.addGroup();
    assert.equal(a.currentGroup.value, '重新出發');
    a.newMemberName.value = '新成員'; a.addMember(); a.loadDemoData();
    assert(a.expenses.value.every(e => e.participants.every(m => a.currentMembers.value.includes(m))));
    const broken = boot('{broken');
    assert(broken.app.saveError.value);
    const quota = boot(undefined, true);
    quota.app.saveData();
    assert(quota.app.saveError.value, 'failed storage is visible');
    const splitEnv = boot();
    const s = splitEnv.app;
    s.newGroupName.value = '分攤驗證'; s.addGroup();
    const names = ['土', '龜', '黑', '樂', '儒', '痴'];
    for (const name of names) { s.newMemberName.value = name; s.addMember(); }
    const counts = Object.fromEntries(names.map(m => [m, { adults: m === '痴' ? 1 : 2, children: 0 }]));
    Object.assign(s.expense.value, { title: '第二天晚餐', amount: 10440, counts, mode: 'people' });
    assert.equal(s.splitPreview.value.error, '');
    assert.equal(s.splitPreview.value.weight, 11);
    assert.deepEqual(Array.from(names, m => s.splitPreview.value.allocations[m]), [1899,1898,1898,1898,1898,949]);
    s.addExpense();
    const dinner = JSON.stringify(s.expenses.value[0]);
    for (const m of names) s.expense.value.counts[m] = { adults: m === '痴' ? 1 : 2, children: ['土','龜','黑'].includes(m) ? 2 : m === '痴' ? 0 : 1 };
    Object.assign(s.expense.value, { title: '中正體育館', amount: 1800, mode: 'half' });
    assert.equal(s.splitPreview.value.weight, 15);
    assert.deepEqual(Array.from(names, m => s.splitPreview.value.allocations[m]), [360,360,360,300,300,120]);
    s.addExpense();
    s.updateFamilyCount('土', 'children', { target: { value: '7' } });
    assert(s.buildCSV().includes('"中正體育館","土","1800","小孩半價","360","360","360","300","300","120"'));
    assert(s.buildCSV().includes('"中正體育館","土","2","2","360"'));
    assert.equal(JSON.stringify(s.expenses.value[0]), dinner, 'saved counts and allocations immutable');
    const netSum = Object.values(s.summary.value).reduce((sum, item) => sum + Math.round(item.net * 100), 0);
    assert.equal(netSum, 0);
    const residual = Object.fromEntries(Object.entries(s.summary.value).map(([name, item]) => [name, Math.round(item.net * 100)]));
    for (const transfer of s.settlements.value) { residual[transfer.from] += Math.round(transfer.amount * 100); residual[transfer.to] -= Math.round(transfer.amount * 100); }
    assert(Object.values(residual).every(n => n === 0), 'transfers settle everyone exactly');
    Object.assign(s.expense.value, { title: '免費小孩', amount: 100.01, mode: 'adults', participants: ['土','龜'], counts: { '土': {adults:1,children:0}, '龜': {adults:0,children:2} } });
    assert.equal(s.splitPreview.value.allocations['土'], 100.01);
    assert.equal(s.splitPreview.value.allocations['龜'], 0);
    s.expense.value.counts['土'].adults = 0; s.expense.value.counts['土'].children = 1;
    assert(s.splitPreview.value.error, 'all free children rejected');
    s.expense.value.mode = 'people';
    assert.equal(Object.values(s.splitPreview.value.allocations).reduce((n,v) => n+Math.round(v*100),0),10001);
    s.expense.value.mode = 'custom'; s.expense.value.customAmounts = { '土': 80, '龜': 20 };
    assert(s.splitPreview.value.error, 'custom mismatch rejected');
    const countBefore = s.expenses.value.length; s.addExpense(); assert.equal(s.expenses.value.length,countBefore);
    s.expense.value.customAmounts['龜'] = 20.01;
    assert.equal(s.splitPreview.value.error, ''); s.addExpense();
    await splitEnv.tick();
    const v3 = splitEnv.store.get('travel-expense-calculator:v1');
    assert.equal(boot(v3).app.expenses.value[2].allocations['龜'],20.01);
    const tampered = JSON.parse(v3); tampered.expenses['分攤驗證'][0].allocations['土']++;
    await s.importBackup(fileEvent(JSON.stringify(tampered)));
    assert.equal(JSON.stringify(s.expenses.value[0]), dinner, 'tampered allocation rejected');
    const old = JSON.parse(v3); old.version = 2;
    old.expenses['分攤驗證'] = [{ title:'舊帳',payer:'土',amount:100,participants:['土','龜','黑'] }];
    const legacyApp = boot(JSON.stringify(old)).app;
    assert.equal(legacyApp.summary.value['土'].shouldPay,34);
    assert.equal(legacyApp.summary.value['龜'].shouldPay,33);
    for (let total = 1; total <= 25; total++) {
        for (const mode of ['people','half','adults']) {
            const result = s.calculateSplit({ amount: total / 100, mode, participants: ['a','b','c'], counts: {a:{adults:1,children:3},b:{adults:0,children:2},c:{adults:2,children:0}} });
            assert.equal(Object.values(result.allocations).reduce((sum,n) => sum+Math.round(n*100),0),total);
            assert(Object.values(result.allocations).every(n => n >= 0));
            if (mode === 'adults') assert.equal(result.allocations.b,0);
        }
    }
    console.log('PASS: dinner/gym examples, all split modes, exact totals/transfers, invalid inputs, immutable snapshots, v3 backups, legacy shares');
    console.log('PASS: group/member CRUD, isolation, protected deletion, autosave, reload, backup validation/import, empty state, demo, storage failures');
})().catch(error => { console.error(error); process.exitCode = 1; });
