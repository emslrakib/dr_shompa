'use strict';

// ---------------------------------------------------------------------------
// Configuration loader.
//
// Any machine can be pointed at its own PostgreSQL server and web port by editing ONE
// file next to server.js:  appsettings.json
//
// Precedence (highest first):
//   1. real environment variables  (IIS service settings, setx, docker, ...)
//   2. appsettings.json + appsettings.<NODE_ENV>.json
//      (the environment specific file may override single values of the base)
//   3. .env  (kept for the older setup / backwards compatibility)
//
// A JSON value that is null, "" or missing counts as "not provided", so leaving
// a field empty never wipes out a password that is configured in .env.
//
// Values are copied into process.env, so the rest of the code (server.js, db.js,
// migrate-db.js) keeps reading process.env exactly as before.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const APP_ROOT = __dirname;
const BASE_FILE = 'appsettings.json';

// "Section:Sub:Key" inside appsettings.json  ->  environment variable the code reads.
// Unknown keys are reported as warnings instead of being applied silently.
const KEY_MAP = {
    'Web:Environment': 'NODE_ENV',
    'Web:Port': 'PORT',
    'Web:TrustProxy': 'TRUST_PROXY',
    'Web:AllowedOrigins': 'ALLOWED_ORIGINS',

    // true (default) = server.js creates missing tables from setup_db.sql at startup
    'Web:AutoMigrate': 'DB_AUTO_MIGRATE',

    // PostgreSQL (the old SQL Server block was removed when the project moved
    // to the free hosting setup — see RENDER_DEPLOYMENT.md).
    // `Url` is one connection string ("postgres://user:pass@host/db"); the other
    // five are the standard libpq variables, handy for a local database.
    'Postgres:Url': 'DATABASE_URL',
    'Postgres:Host': 'PGHOST',
    'Postgres:Name': 'PGDATABASE',
    'Postgres:User': 'PGUSER',
    'Postgres:Password': 'PGPASSWORD',
    'Postgres:Port': 'PGPORT',
    // TLS: empty = decide from the connection string, true/false = force it
    'Postgres:Ssl': 'DB_SSL',

    'Admin:User': 'ADMIN_USER',
    'Admin:Password': 'ADMIN_PASS',

    'Session:Secret': 'SESSION_SECRET',

    'Reminders:DryRun': 'REMINDER_DRY_RUN',
    'Reminders:Template': 'REMINDER_TEMPLATE',
    'Reminders:ClinicEmail': 'CLINIC_EMAIL',
    'Reminders:Sms:ApiUrl': 'SMS_API_URL',
    'Reminders:Sms:ApiKey': 'SMS_API_KEY',
    'Reminders:Sms:AuthHeader': 'SMS_AUTH_HEADER',
    'Reminders:Sms:AuthScheme': 'SMS_AUTH_SCHEME',
    'Reminders:Sms:Method': 'SMS_METHOD',
    'Reminders:Smtp:Host': 'SMTP_HOST',
    'Reminders:Smtp:Port': 'SMTP_PORT',
    'Reminders:Smtp:Secure': 'SMTP_SECURE',
    'Reminders:Smtp:User': 'SMTP_USER',
    'Reminders:Smtp:Password': 'SMTP_PASS',
    'Reminders:Smtp:From': 'SMTP_FROM'
};

const state = {
    loaded: false,
    root: APP_ROOT,
    files: [],        // files that were found and read
    applied: [],      // env keys filled in from the JSON files
    overridden: [],   // env keys where a JSON value replaced a .env value
    skipped: [],      // env keys left alone because a real environment variable is set
    warnings: []
};

// ---------------------------------------------------------------------------
// JSON with comments: appsettings.example.json is commented, JSON.parse is not.
// This removes // and /* */ comments without touching the inside of strings.
// ---------------------------------------------------------------------------
function stripJsonComments(text) {
    let out = '';
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const next = text[i + 1];

        if (inLineComment) {
            if (char === '\n') { inLineComment = false; out += char; }
            continue;
        }
        if (inBlockComment) {
            if (char === '*' && next === '/') { inBlockComment = false; i++; }
            else if (char === '\n') out += char;
            continue;
        }
        if (inString) {
            out += char;
            if (char === '\\') { out += next === undefined ? '' : next; i++; }
            else if (char === '"') inString = false;
            continue;
        }

        if (char === '"') { inString = true; out += char; continue; }
        if (char === '/' && next === '/') { inLineComment = true; i++; continue; }
        if (char === '/' && next === '*') { inBlockComment = true; i++; continue; }
        out += char;
    }

    return out;
}

function readJsonConfig(file) {
    const fullPath = path.isAbsolute(file) ? file : path.join(APP_ROOT, file);
    const raw = fs.readFileSync(fullPath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

    try {
        return JSON.parse(stripJsonComments(raw));
    } catch (err) {
        throw new Error(
            `${path.basename(fullPath)} is not valid JSON — ${err.message}. ` +
            'Check for a missing comma, a trailing comma or an unquoted key.'
        );
    }
}

// Walks the JSON and returns { "Section:Key": value } for every leaf value.
function flattenConfig(value, prefix, out) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        out[prefix] = value;
        return out;
    }
    for (const key of Object.keys(value)) {
        flattenConfig(value[key], prefix ? `${prefix}:${key}` : key, out);
    }
    return out;
}

function toEnvString(value) {
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean).join(',');
    return String(value);
}

// An empty field in appsettings.json means "leave this to .env / the environment".
function isEmptyValue(value) {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    return false;
}

// ---------------------------------------------------------------------------
// load() — call this once, before anything reads process.env.
// ---------------------------------------------------------------------------
function load(env) {
    const target = env || process.env;
    if (state.loaded) return state;
    state.loaded = true;

    // 1) Real environment variables win over every file.
    const fromEnvironment = new Set(Object.keys(target).filter(key => target[key] !== undefined));

    // 2) .env (lowest precedence of the three sources).
    try {
        const result = require('dotenv').config({ path: path.join(APP_ROOT, '.env') });
        if (result.error && result.error.code !== 'ENOENT') {
            state.warnings.push(`.env could not be read: ${result.error.message}`);
        } else if (!result.error) {
            state.files.push('.env');
        }
    } catch (err) {
        state.warnings.push(`dotenv could not be loaded: ${err.message}`);
    }
    const fromDotenv = new Set(
        Object.keys(target).filter(key => target[key] !== undefined && !fromEnvironment.has(key))
    );

    // 3) appsettings.json, then appsettings.<NODE_ENV>.json on top of it.
    const baseFile = target.APPSETTINGS_PATH || BASE_FILE;
    const candidates = [baseFile];
    if (target.NODE_ENV) candidates.push(`appsettings.${target.NODE_ENV}.json`);

    const jsonValues = new Map();   // env key -> value from the JSON files
    for (const file of candidates) {
        const fullPath = path.isAbsolute(file) ? file : path.join(APP_ROOT, file);
        if (!fs.existsSync(fullPath)) continue;

        const parsed = readJsonConfig(file);      // throws with a readable message
        state.files.push(path.basename(fullPath));

        for (const [jsonKey, value] of Object.entries(flattenConfig(parsed, '', {}))) {
            const envKey = KEY_MAP[jsonKey];
            if (!envKey) {
                state.warnings.push(`${path.basename(fullPath)}: unknown setting "${jsonKey}" is ignored`);
                continue;
            }
            if (isEmptyValue(value)) continue;
            jsonValues.set(envKey, toEnvString(value));   // a later file wins
        }
    }

    if (target.APPSETTINGS_DISABLED === 'true') {
        state.warnings.push('APPSETTINGS_DISABLED=true — appsettings.json was skipped');
        jsonValues.clear();
    }

    // 4) Apply, without ever overriding a real environment variable.
    for (const [envKey, value] of jsonValues) {
        if (fromEnvironment.has(envKey)) { state.skipped.push(envKey); continue; }
        if (fromDotenv.has(envKey) && target[envKey] !== value) state.overridden.push(envKey);
        target[envKey] = value;
        state.applied.push(envKey);
    }

    return state;
}

// ---------------------------------------------------------------------------
// describe() — a secret-free summary, handy for "why is this machine talking to
// the wrong server?" checks:  npm.cmd run config:show
// ---------------------------------------------------------------------------

// Where the app connects, without ever printing the password.
function describeDatabase(target) {
    const url = String(target.DATABASE_URL || '').trim();
    if (url) {
        try {
            const parsed = new URL(url);
            return `${parsed.hostname}:${parsed.port || 5432}/${parsed.pathname.replace(/^\//, '')}, user=${parsed.username || '(not set)'}, ssl=${describeSsl(target, url)}`;
        } catch (err) {
            return 'DATABASE_URL (could not be parsed)';
        }
    }
    return `${target.PGHOST || 'localhost'}:${target.PGPORT || 5432}/${target.PGDATABASE || 'DrShompaDB'}, user=${target.PGUSER || '(not set)'}, ssl=${describeSsl(target, '')}`;
}

function describeSsl(target, url) {
    const setting = String(target.DB_SSL || '').trim().toLowerCase();
    if (['true', 'on'].includes(setting)) return 'true';
    if (['false', 'off', 'disable'].includes(setting)) return 'false';
    const mode = (/(?:[?&])sslmode=([a-z-]+)/i.exec(url) || [])[1];
    return mode && mode.toLowerCase() !== 'disable' ? mode.toLowerCase() : 'false';
}
function describe(env) {
    const target = env || process.env;
    const onOff = value => (value === 'true' ? 'true' : 'false');
    const lines = [];

    lines.push('Configuration summary');
    lines.push(`  app folder        : ${state.root}`);
    lines.push(`  configured by     : ${state.files.length ? state.files.join(', ') : '(no .env and no appsettings.json — defaults in use)'}`);
    lines.push(`  web               : http://localhost:${target.PORT || 5000}` +
        `  (NODE_ENV=${target.NODE_ENV || 'development'}, trustProxy=${onOff(target.TRUST_PROXY)})`);
    lines.push(`  database          : ${describeDatabase(target)}`);
    lines.push(`  admin sign-in     : ${target.ADMIN_USER && target.ADMIN_PASS ? `ENABLED (user "${target.ADMIN_USER}")` : 'disabled'}`);
    lines.push(`  reminders         : dryRun=${onOff(target.REMINDER_DRY_RUN)}` +
        `, SMS=${target.SMS_API_URL ? 'configured' : 'off'}, SMTP=${target.SMTP_HOST ? 'configured' : 'off'}`);
    lines.push(`  settings applied  : ${state.applied.length} value(s) came from the files` +
        `${state.overridden.length ? `; ${state.overridden.join(', ')} replaced the .env value` : ''}`);
    if (state.skipped.length) {
        lines.push(`  kept from OS env  : ${state.skipped.join(', ')} (real environment variables are never overridden)`);
    }
    for (const warning of state.warnings) lines.push(`  warning           : ${warning}`);

    return lines.join('\n');
}

// Printed by server.js at startup so the console always shows which machine is
// connected to which database.
function logSummary(logger) {
    const log = logger || console.log;
    log(`⚙️  Config: ${state.files.length ? state.files.join(' + ') : 'built-in defaults'}` +
        ` | db ${describeDatabase(process.env)}` +
        ` | web http://localhost:${process.env.PORT || 5000}`);
    if (state.overridden.length) {
        log(`   appsettings.json overrides .env for: ${state.overridden.join(', ')}`);
    }
    for (const warning of state.warnings) log(`   ⚠️  ${warning}`);
}

module.exports = { load, describe, logSummary, state, KEY_MAP };
