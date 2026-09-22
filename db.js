'use strict';

const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// One settings file per machine: appsettings.json (see config.js).
require('./config').load();

// `DATE` columns are handed to the API as plain 'YYYY-MM-DD' strings. Without
// this parser node-postgres returns a JavaScript Date at local midnight, which
// can shift a calendar date by one day and make an appointment look like it is
// on the wrong day.
types.setTypeParser(1082, value => value);

const SCHEMA_FILE = path.join(__dirname, 'setup_db.sql');

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const DB_SSL_SETTING = (process.env.DB_SSL || '').trim().toLowerCase();

// A managed database (Neon, Supabase, Render, …) always wants TLS and puts
// `sslmode=require` in its connection string — that switches TLS on by itself.
// Local PostgreSQL usually has no TLS at all: set DB_SSL=false (or leave
// sslmode=disable in the URL) for that.
function resolveSsl() {
    if (['false', 'off', 'disable'].includes(DB_SSL_SETTING)) return false;

    const mode = (/(?:[?&])sslmode=([a-z-]+)/i.exec(DATABASE_URL) || [])[1];
    const name = (mode || DB_SSL_SETTING).toLowerCase();
    const wanted = ['true', 'on', 'require', 'prefer', 'verify-ca', 'verify-full'].includes(name);
    if (!wanted) return false;

    // Only `verify-full` actually checks the server certificate; `require`
    // encrypts without verifying, which is what managed hosts' docs show.
    return { rejectUnauthorized: name === 'verify-full' };
}

const POOL_SETTINGS = DATABASE_URL
    ? { connectionString: DATABASE_URL }
    : {
        host: process.env.PGHOST || 'localhost',
        port: Number.parseInt(process.env.PGPORT, 10) || 5432,
        database: process.env.PGDATABASE || 'DrShompaDB',
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || undefined
    };

// The database the application talks to (migrate-db.js creates it when missing).
const TARGET_DATABASE = DATABASE_URL
    ? readDatabaseFromUrl(DATABASE_URL)
    : POOL_SETTINGS.database;

function readDatabaseFromUrl(url) {
    try {
        return new URL(url).pathname.replace(/^\//, '') || 'postgres';
    } catch (err) {
        return 'postgres';
    }
}

// Same connection string, but aimed at the maintenance database.
function withMaintenanceDatabase(url) {
    try {
        const parsed = new URL(url);
        parsed.pathname = '/postgres';
        return parsed.toString();
    } catch (err) {
        return url;
    }
}

const pool = new Pool({
    ...POOL_SETTINGS,
    ssl: resolveSsl(),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    application_name: 'drshompa'
});

let _poolPromise = null;
let _dbConnected = false;
let _schemaPromise = null;

// A broken idle connection must never crash the process: log it, drop the cached
// promise, and let the next request open a fresh connection.
pool.on('error', err => {
    _dbConnected = false;
    _poolPromise = null;
    console.error('❌ An idle PostgreSQL connection dropped — the next request will reconnect.');
    console.error('   Reason  : ' + err.message);
});

// Safe for the console: shows host/database/user but never the password.
function describeTarget() {
    if (DATABASE_URL) {
        try {
            const url = new URL(DATABASE_URL);
            return `${url.hostname}:${url.port || 5432}/${url.pathname.replace(/^\//, '')} user: ${url.username || '(not set)'}`;
        } catch (err) {
            return '(DATABASE_URL — could not be parsed)';
        }
    }
    return `${POOL_SETTINGS.host}:${POOL_SETTINGS.port}/${POOL_SETTINGS.database} user: ${POOL_SETTINGS.user || '(not set)'}`;
}

// Lazy initialization — a connection is only opened when something awaits
// `poolPromise` (or `ensureSchema()`), so require() never blocks startup.
function getPoolPromise() {
    if (!_poolPromise) {
        _poolPromise = pool.query('SELECT current_database() AS name')
            .then(result => {
                _dbConnected = true;
                console.log('✅ Connected to PostgreSQL database:', result.rows[0].name);
                return pool;
            })
            .catch(err => {
                _dbConnected = false;
                // Reset the cached promise so the NEXT request retries the connection.
                // Without this, a single bad moment at startup would keep every API call
                // failing until the process restarts.
                _poolPromise = null;
                console.error('❌ Database connection failed — the web server keeps running and will retry on the next request.');
                console.error(`   Target  : ${describeTarget()}`);
                console.error('   Reason  : ' + err.message);
                return null;
            });
    }
    return _poolPromise;
}

// Creates the tables and the sample content (setup_db.sql) when they are missing.
// The script is idempotent, so calling it on every start is safe — that way a
// fresh database (a new free hosting account, for example) works immediately.
function ensureSchema() {
    if (!_schemaPromise) {
        _schemaPromise = (async () => {
            const ready = await getPoolPromise();
            if (!ready) return false;

            const script = fs.readFileSync(SCHEMA_FILE, 'utf8').replace(/^\uFEFF/, '');
            // No parameters → node-postgres sends the whole file as one simple
            // query, which PostgreSQL executes statement by statement.
            await pool.query(script);
            console.log('🗄️  Database schema is up to date (setup_db.sql).');
            return true;
        })().catch(err => {
            _schemaPromise = null;   // the next call tries again
            console.error('❌ Could not prepare the database schema (setup_db.sql).');
            console.error('   Reason  : ' + err.message);
            return false;
        });
    }
    return _schemaPromise;
}

module.exports = {
    // Use a getter so require() does not trigger a connection — only await/then does
    get poolPromise() {
        return getPoolPromise();
    },
    dbConnected: () => _dbConnected,
    ensureSchema,
    describeTarget,

    // Used by migrate-db.js: which database the app expects …
    targetDatabase: () => TARGET_DATABASE,
    // … and the same connection pointed at an always-existing maintenance
    // database, so a missing application database can be created.
    maintenanceSettings: () => (DATABASE_URL
        ? { connectionString: withMaintenanceDatabase(DATABASE_URL), ssl: resolveSsl() }
        : { ...POOL_SETTINGS, database: 'postgres', ssl: resolveSsl(), application_name: 'drshompa-migrate' }),

    async close() {
        _poolPromise = null;
        _schemaPromise = null;
        _dbConnected = false;
        try {
            await pool.end();
        } catch (err) {
            console.error('Error closing the PostgreSQL connection pool:', err.message);
        }
    }
};
