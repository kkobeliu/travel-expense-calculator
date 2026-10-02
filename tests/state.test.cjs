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
    const fileEvent = text => ({ target: { value: 'backup.json', files: [{ size: text.length, text: async () => text }] } });
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
    console.log('PASS: group/member CRUD, isolation, protected deletion, autosave, reload, backup validation/import, empty state, demo, storage failures');
})().catch(error => { console.error(error); process.exitCode = 1; });
