'use strict';

// ---------------------------------------------------------------------------
// Creates the PostgreSQL database (if it does not exist yet) and applies
// setup_db.sql — tables, indexes and sample content.
//
//   npm.cmd run db:migrate
//
// Connection details come from appsettings.json / .env / real environment
// variables (see config.js). Nothing here drops or overwrites existing data:
// setup_db.sql is written to be safe to run again and again.
// ---------------------------------------------------------------------------

const { Client } = require('pg');

require('./config').load();
const db = require('./db');

async function createDatabaseIfMissing() {
    const name = db.targetDatabase();
    const client = new Client(db.maintenanceSettings());
    await client.connect();

    try {
        const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
        if (found.rowCount) {
            console.log(`Database "${name}" already exists.`);
            return false;
        }

        // A database name cannot be passed as a parameter — it is a quoted
        // identifier, so double quotes inside it are escaped by doubling.
        await client.query(`CREATE DATABASE "${String(name).replace(/"/g, '""')}"`);
        console.log(`Created database "${name}".`);
        return true;
    } finally {
        await client.end();
    }
}

async function main() {
    console.log(`Target: ${db.describeTarget()}`);
    await createDatabaseIfMissing();

    const pool = await db.poolPromise;
    if (!pool) {
        throw new Error(`Could not connect to PostgreSQL (${db.describeTarget()}).`);
    }

    const schemaReady = await db.ensureSchema();
    if (!schemaReady) {
        throw new Error('The schema could not be created — see the message above.');
    }

    const tables = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('Appointments', 'SiteSettings', 'Services',
                             'Testimonials', 'Qualifications', 'ReminderLog')
        ORDER BY table_name
    `);

    const index = await pool.query(`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'IX_Appointments_PreferredDate_Status'
    `);

    const counts = await pool.query(`
        SELECT
            (SELECT COUNT(*) FROM "Appointments")::int   AS appointments,
            (SELECT COUNT(*) FROM "SiteSettings")::int   AS settings,
            (SELECT COUNT(*) FROM "Services")::int       AS services,
            (SELECT COUNT(*) FROM "Testimonials")::int   AS testimonials,
            (SELECT COUNT(*) FROM "Qualifications")::int AS qualifications
    `);

    console.log('Migration completed successfully.');
    console.log('Tables:', tables.rows.map(row => row.table_name).join(', '));
    console.log('Appointment index:', index.rowCount === 1 ? 'ready' : 'missing');
    console.log('Data counts:', JSON.stringify(counts.rows[0]));
}

main()
    .then(async () => {
        await db.close();
    })
    .catch(async err => {
        console.error('Migration failed:', err.message);
        try {
            await db.close();
        } catch (closeErr) {
            // the connection is already gone — nothing left to clean up
        }
        process.exit(1);
    });
