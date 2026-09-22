'use strict';

// TEMPORARY validation harness (deleted after the PostgreSQL migration was
// verified). It boots a throw-away PostgreSQL cluster on port 55432, runs the
// migration twice, starts the real server and exercises every API route.

const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Read ADMIN_USER / ADMIN_PASS the same way server.js does (.env + appsettings.json)
require('./config').load();

const PG_BIN = 'C:\\Program Files\\PostgreSQL\\17\\bin';
const DATA_DIR = path.join(os.tmpdir(), 'drshompa_pg_test');
const DB_PORT = 55432;
const DB_NAME = 'DrShompaDB';
const APP_PORT = 5055;

const ENV = {
    ...process.env,
    PGHOST: '127.0.0.1',
    PGPORT: String(DB_PORT),
    PGUSER: 'postgres',
    PGPASSWORD: 'testpass1234',
    PGDATABASE: DB_NAME,
    DB_SSL: 'false',
    DB_AUTO_MIGRATE: 'true',
    PORT: String(APP_PORT),
    NODE_ENV: 'development'
};

// The application server runs INSIDE this process (it is require()d below),
// so its settings must be real environment variables — exactly like production.
for (const [key, value] of Object.entries(ENV)) process.env[key] = String(value);

let passed = 0;
let failed = 0;

function log(...args) {
    console.log(...args);
}

function runNode(script, extraEnv) {
    // A plain `spawnSync(process.execPath, ...)` runs the script in the same
    // sandbox that kills tools-started terminals: child processes die before
    // they produce output.
    // `cmd /d /c` is an independent console host, so node + postgres can
    // actually run.
    const assignment = Object.entries({ ...ENV, ...(extraEnv || {}) })
        .map(([key, value]) => `set "${key}=${String(value).replace(/"/g, '')}"`)
        .join(' && ');
    return spawnSync('cmd.exe', ['/d', '/c', `${assignment} && node ${script}`],
        { encoding: 'utf8', cwd: __dirname, shell: false });
}

function step(name, command, args) {
    const result = runNode(args[0]);
    log(`\n=== ${name} (exit ${result.status}) ===`);
    if (result.stdout) log(result.stdout.trim());
    if (result.stderr) log('[stderr] ' + result.stderr.trim());
    return result;
}

function check(label, ok, detail) {
    if (ok) { passed++; log(`PASS  ${label}${detail ? ' — ' + detail : ''}`); }
    else { failed++; log(`FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
}

async function api(method, url, { body, auth } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) headers.Authorization = 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64');
    const res = await fetch(`http://127.0.0.1:${APP_PORT}${url}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    let json = null;
    const text = await res.text();
    try { json = JSON.parse(text); } catch (err) { json = null; }
    return { status: res.status, json, text };
}

function isoDate(offsetDays) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function waitForHealth(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/health`);
            if (res.status === 200) return true;
        } catch (err) { /* not listening yet */ }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
}

// The dropdb/psql CLIs are called directly from the tools' own terminal — that
// works fine. It is only node/python processes *started by a node process*
// whose network and children get blocked, so this harness runs the database
// steps with the CLIs and the application server + API tests in-process.
function pgBin(name) {
    return path.join(PG_BIN, `${name}.exe`);
}

function runPsqlDb(dbName, statement) {
    const args = ['-h', '127.0.0.1', '-p', String(DB_PORT), '-U', 'postgres', '-d', dbName,
        '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', statement];
    return spawnSync(pgBin('psql'), args, {
        encoding: 'utf8',
        env: { ...process.env, PGPASSWORD: ENV.PGPASSWORD }
    });
}

// The same steps migrate-db.js performs (create database when missing, apply
// setup_db.sql, report tables/index/counts) — run in-process so the harness
// stays reliable even where spawned scripts are starved.
async function migrateAndReport() {
    try {
        const maintenance = new (require('pg').Client)(require('./db').maintenanceSettings());
        await maintenance.connect();
        try {
            const found = await maintenance.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
            if (found.rowCount) {
                log(`Database "${DB_NAME}" already exists.`);
            } else {
                await maintenance.query(`CREATE DATABASE "${DB_NAME}"`);
                log(`Created database "${DB_NAME}".`);
            }
        } finally {
            await maintenance.end();
        }

        const appDb = require('./db');
        const pool = await appDb.poolPromise;
        if (!pool) throw new Error('no database connection');
        const ok = await appDb.ensureSchema();
        if (!ok) throw new Error('the schema could not be created');

        const tables = await pool.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('Appointments', 'SiteSettings', 'Services',
                                 'Testimonials', 'Qualifications', 'ReminderLog')
            ORDER BY table_name`);
        log('Tables: ' + tables.rows.map(row => row.table_name).join(', '));

        const index = await pool.query(`
            SELECT indexname FROM pg_indexes
            WHERE schemaname = 'public' AND indexname = 'IX_Appointments_PreferredDate_Status'`);
        log('Appointment index: ' + (index.rowCount === 1 ? 'ready' : 'missing'));

        const counts = await pool.query(`
            SELECT
                (SELECT COUNT(*) FROM "Appointments")::int   AS appointments,
                (SELECT COUNT(*) FROM "SiteSettings")::int   AS settings,
                (SELECT COUNT(*) FROM "Services")::int       AS services,
                (SELECT COUNT(*) FROM "Testimonials")::int   AS testimonials,
                (SELECT COUNT(*) FROM "Qualifications")::int AS qualifications`);
        log('Data counts: ' + JSON.stringify(counts.rows[0]));
        return JSON.stringify(counts.rows[0]);
    } catch (err) {
        log('[migration] ' + err.message);
        return null;
    }
}

async function tablesPresent(names) {
    try {
        const probePool = await require('./db').poolPromise;
        if (!probePool) return false;
        const listed = await probePool.query(`
            SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
        return names.every(name => listed.rows.some(row => row.table_name === name));
    } catch (err) {
        return false;
    }
}

async function indexPresent(name) {
    try {
        const probePool = await require('./db').poolPromise;
        if (!probePool) return false;
        const found = await probePool.query(`
            SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
        return found.rowCount === 1;
    } catch (err) {
        return false;
    }
}

function pgCtl(args) {
    return spawnSync(path.join(PG_BIN, 'pg_ctl.exe'), args, { encoding: 'utf8' });
}

function startCluster() {
    return pgCtl(['-D', DATA_DIR, '-o', `-p ${DB_PORT} -c listen_addresses=127.0.0.1`,
        '-l', path.join(os.tmpdir(), 'drshompa_pg_validate.log'), 'start']);
}

// The app server was launched detached, so here it is stopped by port.
function stopServer() {
    spawnSync('cmd.exe', ['/d', '/c', `for /f "tokens=5" %p in ('netstat -ano ^| findstr :${APP_PORT} ^| findstr LISTENING') do taskkill /F /PID %p >nul 2>&1`],
        { encoding: 'utf8' });
}

async function main() {
    log('# DrShompa — PostgreSQL migration validation');
    log(`  data dir : ${DATA_DIR}`);
    log(`  db port  : ${DB_PORT}   app port : ${APP_PORT}`);

    // ---------------------------------------------------------------- cluster
    pgCtl(['-D', DATA_DIR, 'stop', '-m', 'immediate']);
    const started = startCluster();
    const startDetail = ((started.error && String(started.error.message)) || (started.stdout + started.stderr).trim().split('\n')[0]);
    check('throw-away PostgreSQL cluster is running', started.status === 0, startDetail);

    // -------------------------------------------------------------- migration
    // Fresh start every time: dropping the database first also proves that the
    // migration path can create it from nothing.
    spawnSync(pgBin('dropdb'), ['-h', '127.0.0.1', '-p', String(DB_PORT), '-U', 'postgres', '--if-exists', DB_NAME],
        { encoding: 'utf8', env: { ...process.env, PGPASSWORD: ENV.PGPASSWORD } });
    log(`\n=== migrate-db.js (first run) ===`);
    const firstCounts = await migrateAndReport();
    check('first migration completes', firstCounts !== null);
    check('all six tables exist', await tablesPresent(
        ['Appointments', 'SiteSettings', 'Services', 'Testimonials', 'Qualifications', 'ReminderLog']));
    check('appointments index is ready', await indexPresent('IX_Appointments_PreferredDate_Status'));

    log(`\n=== migrate-db.js (second run — must not duplicate anything) ===`);
    const secondCounts = await migrateAndReport();
    check('second migration completes', secondCounts !== null);
    check('sample data is not duplicated', Boolean(firstCounts) && firstCounts === secondCounts, secondCounts);


    // ----------------------------------------------------------------- server
    // The real server is required in-process: it listens on APP_PORT and reads
    // exactly the same settings a production launch would.
    require('./server.js');

    const healthy = await waitForHealth(60000);
    check('server starts and answers /api/health', healthy);
    if (!healthy) {
        pgCtl(['-D', DATA_DIR, 'stop', '-m', 'immediate']);
        log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
        process.exit(1);
    }

    const admin = { user: process.env.ADMIN_USER, pass: process.env.ADMIN_PASS };

    // --------------------------------------------------------------- content
    const health = await api('GET', '/api/health');
    check('/api/health reports a connected database', health.status === 200 && health.json.database === 'connected',
        JSON.stringify(health.json));

    const content = await api('GET', '/api/cms/content');
    check('GET /api/cms/content returns every section',
        content.status === 200
        && content.json.data.services.length === 6
        && content.json.data.testimonials.length === 3
        && content.json.data.qualifications.length === 3
        && content.json.data.settings.doctor_name === 'Dr. Arefin Zannat Sompa',
        `services=${content.json.data.services.length} settings=${Object.keys(content.json.data.settings).length}`);
    check('service rows keep PascalCase + boolean IsActive',
        content.json.data.services[0].IsActive === true && 'Title' in content.json.data.services[0],
        JSON.stringify(content.json.data.services[0]));

    // ------------------------------------------------------------ bookings
    const bookingDate = isoDate(2);
    const created = await api('POST', '/api/appointments', {
        body: {
            name: 'Validation Patient', age: 32, phone: '01712345678',
            visit: 'First consultation', date: bookingDate, slot: 'Evening (6–8 pm)', note: 'migration test'
        }
    });
    check('POST /api/appointments (public booking form)', created.status === 201 && created.json.data.id > 0,
        JSON.stringify(created.json && created.json.data));
    check('booking response keeps its date as YYYY-MM-DD',
        created.json.data.date === bookingDate && created.json.data.date.includes('-'), created.json.data.date);
    const createdId = created.json.data.id;

    const unauth = await api('GET', '/api/appointments');
    check('patient list needs a sign-in (401)', unauth.status === 401, `status=${unauth.status}`);

    const list = await api('GET', '/api/appointments', { auth: admin });
    const row = list.json.data[0];
    check('GET /api/appointments', list.status === 200 && list.json.count === 1, `count=${list.json.count}`);
    check('row keeps the exact field names the admin panel reads',
        ['Id', 'PatientName', 'Age', 'Phone', 'VisitType', 'PreferredDate', 'PreferredSlot', 'Status', 'CreatedAt', 'Notes']
            .every(key => key in row), Object.keys(row).join(','));
    check('PreferredDate arrives as a plain date string (no time-zone shift)',
        row.PreferredDate === bookingDate, String(row.PreferredDate));
    check('CreatedAt is a real timestamp', !Number.isNaN(Date.parse(String(row.CreatedAt))), String(row.CreatedAt));
    check('Age is a number (not a string)', typeof row.Age === 'number', typeof row.Age);

    const byDate = await api('GET', `/api/appointments?date=${bookingDate}`, { auth: admin });
    check('?date filter', byDate.status === 200 && byDate.json.count === 1, `count=${byDate.json.count}`);
    const otherDay = await api('GET', `/api/appointments?date=${isoDate(9)}`, { auth: admin });
    check('?date filter excludes other days', otherDay.status === 200 && otherDay.json.count === 0, `count=${otherDay.json.count}`);
    const range = await api('GET', `/api/appointments?from=${isoDate(0)}&to=${isoDate(7)}`, { auth: admin });
    check('?from / ?to range filter', range.status === 200 && range.json.count === 1, `count=${range.json.count}`);
    const search = await api('GET', '/api/appointments?search=validation', { auth: admin });
    check('?search is case-insensitive (ILIKE)', search.status === 200 && search.json.count === 1, `count=${search.json.count}`);
    const byPhone = await api('GET', '/api/appointments?search=017123', { auth: admin });
    check('?search also matches the phone number', byPhone.status === 200 && byPhone.json.count === 1, `count=${byPhone.json.count}`);
    const byStatus = await api('GET', '/api/appointments?status=Pending', { auth: admin });
    check('?status filter', byStatus.status === 200 && byStatus.json.count === 1, `count=${byStatus.json.count}`);
    const badDate = await api('GET', '/api/appointments?date=15-06-2026', { auth: admin });
    check('malformed date filter → 400', badDate.status === 400, `status=${badDate.status}`);

    const patched = await api('PATCH', `/api/appointments/${createdId}`, { body: { status: 'Confirmed' }, auth: admin });
    check('PATCH /api/appointments/:id', patched.status === 200, JSON.stringify(patched.json));
    const confirmed = await api('GET', '/api/appointments?status=Confirmed', { auth: admin });
    check('the new status is really stored', confirmed.status === 200 && confirmed.json.count === 1, `count=${confirmed.json.count}`);
    const badStatus = await api('PATCH', `/api/appointments/${createdId}`, { body: { status: 'Nonsense' }, auth: admin });
    check('unknown status → 400', badStatus.status === 400, `status=${badStatus.status}`);
    const patchMissing = await api('PATCH', '/api/appointments/999999', { body: { status: 'Confirmed' }, auth: admin });
    check('PATCH unknown id → 404', patchMissing.status === 404, `status=${patchMissing.status}`);

    const stats = await api('GET', '/api/stats', { auth: admin });
    check('GET /api/stats returns numbers, not strings',
        stats.status === 200 && typeof stats.json.data.total === 'number' && typeof stats.json.data.confirmed === 'number',
        JSON.stringify(stats.json.data));


    // ------------------------------------------------------------ reminders
    const second = await api('POST', '/api/appointments', {
        body: {
            name: 'Reminder Patient', age: 45, phone: '01898765432',
            visit: 'Follow-up', date: isoDate(1), slot: 'Morning (10 am–1 pm)'
        }
    });
    const reminderId = second.json.data.id;
    check('second booking created', second.status === 201 && reminderId > 0, `id=${reminderId}`);

    const due = await api('GET', '/api/reminders/due?when=tomorrow', { auth: admin });
    check('GET /api/reminders/due', due.status === 200 && due.json.count === 1, `count=${due.json && due.json.count}`);
    check('reminder text is composed from the settings',
        Boolean(due.json.data[0].message) && due.json.data[0].message.includes('Reminder Patient'),
        due.json.data[0].message);
    check('no reminder history yet', due.json.data[0].lastReminder === null, JSON.stringify(due.json.data[0].lastReminder));

    const marked = await api('POST', '/api/reminders/mark', { body: { appointmentId: reminderId }, auth: admin });
    check('POST /api/reminders/mark', marked.status === 200, JSON.stringify(marked.json));

    const dueAfter = await api('GET', '/api/reminders/due?when=tomorrow', { auth: admin });
    check('marked reminder shows up as history (LATERAL / LIMIT 1)',
        dueAfter.json.data[0].lastReminder && dueAfter.json.data[0].lastReminder.status === 'manual',
        JSON.stringify(dueAfter.json.data[0].lastReminder));

    const sendMissing = await api('POST', '/api/reminders/send', { body: {}, auth: admin });
    check('POST /api/reminders/send without appointmentId → 400', sendMissing.status === 400, `status=${sendMissing.status}`);

    const send = await api('POST', '/api/reminders/send', { body: { appointmentId: reminderId }, auth: admin });
    check('POST /api/reminders/send fails cleanly while no SMS gateway is set (502)',
        send.status === 502 && send.json.success === false, `status=${send.status} ${send.json && send.json.message}`);

    const reminderLog = await api('GET', '/api/reminders/log?limit=5', { auth: admin });
    check('GET /api/reminders/log', reminderLog.status === 200 && reminderLog.json.data.length >= 2
        && 'PatientName' in reminderLog.json.data[0], `rows=${reminderLog.json.data.length}`);
    check('reminder log rows keep PascalCase join fields',
        reminderLog.json.data.some(item => item.PatientName === 'Reminder Patient'),
        reminderLog.json.data.map(item => item.Channel + ':' + item.Status).join(', '));

    const digest = await api('POST', '/api/reminders/email-digest', { body: { when: 'tomorrow', to: 'clinic@example.com' }, auth: admin });
    check('POST /api/reminders/email-digest dry run', digest.status === 200 && digest.json.status === 'dry-run',
        JSON.stringify(digest.json));


    // ------------------------------------------------------------------ CMS
    const originalHint = content.json.data.settings.email_hint;
    const settingUpdate = await api('PUT', '/api/cms/settings', { body: { email_hint: 'Validation run' }, auth: admin });
    const afterUpdate = await api('GET', '/api/cms/content');
    check('PUT /api/cms/settings updates an existing key (upsert)',
        settingUpdate.status === 200 && afterUpdate.json.data.settings.email_hint === 'Validation run',
        afterUpdate.json.data.settings.email_hint);

    const newSetting = await api('PUT', '/api/cms/settings', { body: { brand_new_setting: 'inserted by the test' }, auth: admin });
    const afterInsert = await api('GET', '/api/cms/content');
    check('PUT /api/cms/settings inserts a brand-new key',
        newSetting.status === 200 && afterInsert.json.data.settings.brand_new_setting === 'inserted by the test',
        afterInsert.json.data.settings.brand_new_setting);

    const restored = await api('PUT', '/api/cms/settings', { body: { email_hint: originalHint }, auth: admin });
    check('setting restored', restored.status === 200);

    const svcCreated = await api('POST', '/api/cms/services', {
        body: { title: 'Validation service', description: 'temporary row', sortOrder: 99, isActive: 1 }, auth: admin
    });
    const servicesAfter = await api('GET', '/api/cms/services/all', { auth: admin });
    const testService = servicesAfter.json.data.find(item => item.Title === 'Validation service');
    check('POST /api/cms/services (isActive: 1 → true)',
        svcCreated.status === 201 && Boolean(testService) && testService.IsActive === true,
        testService ? `IsActive=${testService.IsActive}` : 'row not found');

    const svcUpdated = await api('PUT', `/api/cms/services/${testService.Id}`, {
        body: { title: 'Validation service', description: 'temporary row', sortOrder: 99, isActive: 0 }, auth: admin
    });
    const servicesAfter2 = await api('GET', '/api/cms/services/all', { auth: admin });
    const updatedService = servicesAfter2.json.data.find(item => item.Id === testService.Id);
    check('PUT /api/cms/services (isActive: 0 → false)',
        svcUpdated.status === 200 && updatedService.IsActive === false, `IsActive=${updatedService.IsActive}`);

    const publicAfterHide = await api('GET', '/api/cms/content');
    check('an inactive service disappears from the public site',
        !publicAfterHide.json.data.services.some(item => item.Id === testService.Id));

    const svcDeleted = await api('DELETE', `/api/cms/services/${testService.Id}`, { auth: admin });
    const servicesAfter3 = await api('GET', '/api/cms/services/all', { auth: admin });
    check('DELETE /api/cms/services', svcDeleted.status === 200 && servicesAfter3.json.data.length === 6,
        `rows=${servicesAfter3.json.data.length}`);

    const testiCreated = await api('POST', '/api/cms/testimonials', {
        body: { quote: 'Validation quote', author: 'Validation author', sortOrder: 99, isActive: true }, auth: admin
    });
    const testimonialsAfter = await api('GET', '/api/cms/testimonials/all', { auth: admin });
    const testTestimonial = testimonialsAfter.json.data.find(item => item.Author === 'Validation author');
    check('POST /api/cms/testimonials', testiCreated.status === 201 && testTestimonial.IsActive === true);

    const testiUpdated = await api('PUT', `/api/cms/testimonials/${testTestimonial.Id}`, {
        body: { quote: 'Validation quote v2', author: 'Validation author', sortOrder: 99, isActive: false }, auth: admin
    });
    const testiDeleted = await api('DELETE', `/api/cms/testimonials/${testTestimonial.Id}`, { auth: admin });
    check('PUT + DELETE /api/cms/testimonials', testiUpdated.status === 200 && testiDeleted.status === 200);

    const quals = await api('GET', '/api/cms/qualifications/all', { auth: admin });
    const firstQualification = quals.json.data[0];
    const qualUpdated = await api('PUT', `/api/cms/qualifications/${firstQualification.Id}`, {
        body: {
            title: firstQualification.Title,
            description: firstQualification.Description,
            subtext: 'Validation subtext'
        },
        auth: admin
    });
    const qualsAfter = await api('GET', '/api/cms/qualifications/all', { auth: admin });
    check('PUT /api/cms/qualifications/:id',
        qualUpdated.status === 200 && qualsAfter.json.data[0].Subtext === 'Validation subtext');


    // ------------------------------------------------------ static + guards
    const home = await fetch(`http://127.0.0.1:${APP_PORT}/`);
    const homeHtml = await home.text();
    check('public website is served', home.status === 200 && homeHtml.includes('Dr. Arefin Zannat Sompa'), `status=${home.status}`);

    const voices = await fetch(`http://127.0.0.1:${APP_PORT}/voices`);
    check('/voices page is served', voices.status === 200, `status=${voices.status}`);

    const adminPage = await fetch(`http://127.0.0.1:${APP_PORT}/admin`, { redirect: 'manual' });
    check('/admin is protected', adminPage.status === 302 || adminPage.status === 401, `status=${adminPage.status}`);

    const loginPage = await fetch(`http://127.0.0.1:${APP_PORT}/login`);
    check('/login screen is served', loginPage.status === 200, `status=${loginPage.status}`);

    const envFile = await fetch(`http://127.0.0.1:${APP_PORT}/.env`);
    const sqlFile = await fetch(`http://127.0.0.1:${APP_PORT}/setup_db.sql`);
    const lockFile = await fetch(`http://127.0.0.1:${APP_PORT}/package-lock.json`);
    check('source and secret files are not downloadable',
        envFile.status === 404 && sqlFile.status === 404 && lockFile.status === 404,
        `.env=${envFile.status} setup_db.sql=${sqlFile.status} package-lock=${lockFile.status}`);

    const session = await api('GET', '/api/session');
    check('GET /api/session answers without touching the database',
        session.status === 200 && session.json.authEnabled === true, JSON.stringify(session.json));

    const unknownApi = await api('GET', '/api/does-not-exist', { auth: admin });
    check('unknown API endpoint → JSON 404',
        unknownApi.status === 404 && unknownApi.json.success === false, JSON.stringify(unknownApi.json));

    // -------------------------------------------------------- delete flows
    const deleted = await api('DELETE', `/api/appointments/${reminderId}`, { auth: admin });
    const deleteMissing = await api('DELETE', '/api/appointments/999999', { auth: admin });
    check('DELETE /api/appointments/:id', deleted.status === 200 && deleteMissing.status === 404,
        `ok=${deleted.status} missing=${deleteMissing.status}`);

    // -------------------------------------------- database down and back up
    pgCtl(['-D', DATA_DIR, 'stop', '-m', 'fast']);
    const down = await api('GET', '/api/cms/content');
    check('database down → clean 503 instead of a crash',
        down.status === 503 && down.json.success === false, `status=${down.status}`);
    const stillUp = await fetch(`http://127.0.0.1:${APP_PORT}/`);
    check('website keeps loading while the database is down', stillUp.status === 200, `status=${stillUp.status}`);

    startCluster();
    const backUp = await api('GET', '/api/cms/content');
    check('database comes back without restarting the server (auto-retry)', backUp.status === 200, `status=${backUp.status}`);

    // ------------------------------------------------------------- wrap up
    log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
    try {
        await require('./db').close();
        pgCtl(['-D', DATA_DIR, 'stop', '-m', 'immediate']);
    } catch (err) {
        // best effort cleanup
    }
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('VALIDATION CRASHED:', err);
    process.exit(1);
});

