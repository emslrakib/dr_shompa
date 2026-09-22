const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

// Configuration: appsettings.json (+ appsettings.<NODE_ENV>.json) beats .env,
// real environment variables beat both. See config.js and appsettings.example.json.
const config = require('./config');
config.load();

const app = express();
const PORT = Number.parseInt(process.env.PORT, 10) || 5000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(value => value.trim()).filter(Boolean);

if (TRUST_PROXY) app.set('trust proxy', 1);

// Is the PostgreSQL connection encrypted? True when the connection string asks
// for it (managed databases always do: `sslmode=require`) or when DB_SSL=true
// is set. A local database without TLS is fine for development.
function databaseTransportIsEncrypted() {
    const setting = String(process.env.DB_SSL || '').trim().toLowerCase();
    if (['false', 'off', 'disable'].includes(setting)) return false;
    if (['true', 'on', 'require', 'prefer', 'verify-ca', 'verify-full'].includes(setting)) return true;

    const mode = (/(?:[?&])sslmode=([a-z-]+)/i.exec(String(process.env.DATABASE_URL || '')) || [])[1];
    return Boolean(mode && mode.toLowerCase() !== 'disable');
}

// DB module is lazy-loaded — a connection only happens when a route handler calls
// await db.poolPromise. Requiring it does NOT block server startup.
const db = require('./db');


// ---------------------------------------------------------------------------
// Optional admin protection.
// It stays OFF unless BOTH ADMIN_USER and ADMIN_PASS are set in .env, so local
// use is unchanged while a deployed copy can be locked down.
// ---------------------------------------------------------------------------
const ADMIN_USER = (process.env.ADMIN_USER || '').trim();
const ADMIN_PASS = (process.env.ADMIN_PASS || '').trim();
const AUTH_ENABLED = Boolean(ADMIN_USER && ADMIN_PASS);

// Session cookies are signed with this secret. SESSION_SECRET in .env keeps the same
// secret across restarts; otherwise it is derived from the admin credentials.
const SESSION_COOKIE = 'drshompa_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;      // normal sign-in: one working day (8 hours)
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // "keep me signed in": 30 days
const SESSION_SECRET = process.env.SESSION_SECRET
    || crypto.createHash('sha256').update(`${ADMIN_USER}:${ADMIN_PASS}:drshompa`).digest('hex');

if (IS_PRODUCTION) {
    const configurationErrors = [];
    if (!AUTH_ENABLED) configurationErrors.push('ADMIN_USER and ADMIN_PASS must be set');
    if (!process.env.SESSION_SECRET || String(process.env.SESSION_SECRET).trim().length < 32) {
        configurationErrors.push('SESSION_SECRET must be set to a random value of at least 32 characters');
    }
    if (!databaseTransportIsEncrypted()) {
        configurationErrors.push('the database connection must use TLS (DB_SSL=true, or sslmode=require in DATABASE_URL)');
    }
    if (configurationErrors.length) {
        throw new Error(`Unsafe production configuration: ${configurationErrors.join('; ')}.`);
    }
}

function safeEqual(a, b) {
    const bufA = Buffer.from(String(a), 'utf8');
    const bufB = Buffer.from(String(b), 'utf8');
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function clientIp(req) {
    return String(req.ip || req.socket.remoteAddress || 'unknown');
}

// Checkboxes arrive as true, 1 or "1" depending on the caller — PostgreSQL wants
// a real boolean for its BOOLEAN columns ("IsActive").
function toBool(value, fallback = true) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(text)) return false;
    if (['1', 'true', 'yes', 'on'].includes(text)) return true;
    return fallback;
}

function createRateLimiter({ windowMs, max, message }) {
    const hits = new Map();
    return (req, res, next) => {
        const now = Date.now();
        const key = clientIp(req);
        const entry = hits.get(key);
        const active = !entry || entry.resetAt <= now ? { count: 0, resetAt: now + windowMs } : entry;
        active.count += 1;
        hits.set(key, active);

        res.set('RateLimit-Limit', String(max));
        res.set('RateLimit-Remaining', String(Math.max(0, max - active.count)));
        res.set('RateLimit-Reset', String(Math.ceil(active.resetAt / 1000)));
        if (active.count > max) {
            res.set('Retry-After', String(Math.ceil((active.resetAt - now) / 1000)));
            return res.status(429).json({ success: false, message });
        }
        next();
    };
}

function requireSameOrigin(req, res, next) {
    const origin = String(req.headers.origin || '');
    if (!origin) return next(); // curl, server-side jobs and same-site form posts without Origin
    const expectedOrigin = `${req.protocol}://${req.get('host')}`;
    if (origin === expectedOrigin || ALLOWED_ORIGINS.includes(origin)) return next();
    return res.status(403).json({ success: false, message: 'This request origin is not allowed.' });
}

function signSession(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
    return `${body}.${sig}`;
}

// Live sessions are tracked in memory, so signing out really invalidates the token
// instead of only clearing the browser cookie. A server restart simply asks the
// admin to sign in again, which is normal for a control panel.
const activeSessions = new Map(); // session id -> expiry timestamp

function pruneExpiredSessions() {
    const now = Date.now();
    for (const [sid, exp] of activeSessions) {
        if (exp <= now) activeSessions.delete(sid);
    }
}

function createSession(username, ttlMs = SESSION_TTL_MS) {
    pruneExpiredSessions();
    const sid = crypto.randomBytes(18).toString('base64url');
    const exp = Date.now() + ttlMs;
    activeSessions.set(sid, exp);
    return signSession({ sid, u: username, exp });
}

function endSession(req) {
    const payload = verifySession(parseCookies(req)[SESSION_COOKIE]);
    if (payload && payload.sid) activeSessions.delete(payload.sid);
}

function verifySession(token) {
    if (!token) return null;
    const [body, sig] = String(token).split('.');
    if (!body || !sig) return null;

    const want = Buffer.from(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url'), 'utf8');
    const given = Buffer.from(sig, 'utf8');
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;

    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        return payload && payload.exp > Date.now() ? payload : null;
    } catch (err) {
        return null;
    }
}

function parseCookies(req) {
    const jar = {};
    String(req.headers.cookie || '').split(';').forEach(part => {
        const at = part.indexOf('=');
        if (at > -1) jar[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
    });
    return jar;
}

function isLoggedIn(req) {
    const payload = verifySession(parseCookies(req)[SESSION_COOKIE]);
    if (!payload || payload.u !== ADMIN_USER) return false;
    // must also be an active (not signed-out, not expired) server-side session
    const expiresAt = activeSessions.get(payload.sid);
    return typeof expiresAt === 'number' && expiresAt > Date.now();
}

// Blocks the admin panel, patient records and content editing.
// A browser gets redirected to the login screen, API clients get JSON 401.
// HTTP Basic is still accepted so scripts and curl keep working.
function requireAdmin(req, res, next) {
    if (isLoggedIn(req)) return next();

    const [scheme, token] = String(req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && token) {
        const decoded = Buffer.from(token, 'base64').toString('utf8');
        const sep = decoded.indexOf(':');
        if (sep > -1 && safeEqual(decoded.slice(0, sep), ADMIN_USER) && safeEqual(decoded.slice(sep + 1), ADMIN_PASS)) {
            return next();
        }
    }

    if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
        return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    }
    res.status(401).json({ success: false, mustLogin: true, message: 'Please sign in to continue.' });
}

// Middleware. The public site and API are served from the same origin; cross-origin
// browser calls are denied unless a trusted deployment origin is explicitly configured.
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        'Content-Security-Policy': "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:"
    });
    if (IS_PRODUCTION) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});
app.use(cors({
    origin(origin, callback) {
        // Same-origin requests do not need CORS headers. Only explicitly listed
        // cross-origin browser clients receive them; all state-changing routes
        // additionally enforce their origin with requireSameOrigin().
        callback(null, Boolean(origin && ALLOWED_ORIGINS.includes(origin)));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '100kb', extended: false }));

const loginRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Too many sign-in attempts. Please wait and try again.'
});
const bookingRateLimit = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: 'Too many appointment requests from this connection. Please try again later.'
});

// ---------------------------------------------------------------------------
// Security guards — registered BEFORE the static handler and the routes
// ---------------------------------------------------------------------------

// Admin / patient-data surfaces. The public site keeps working because
// GET /api/cms/content and POST /api/appointments (the booking form) stay open.
if (AUTH_ENABLED) {
    app.use([
        '/admin',
        '/admin.html',
        '/api/stats',
        '/api/reminders',
        '/api/cms/settings',
        '/api/cms/services',
        '/api/cms/testimonials',
        '/api/cms/qualifications'
    ], requireAdmin);

    app.use('/api/appointments', (req, res, next) => {
        if (req.method === 'POST' && (req.path === '/' || req.path === '')) return next(); // public booking form
        return requireAdmin(req, res, next);
    });
}

// The frontend is self-contained HTML + images, so source, config, log and
// debug-dump files must never be downloadable from the browser.
app.use((req, res, next) => {
    if (req.path.includes('/.') || /\.(js|json|sql|md|log|txt|cmd|bat|ps1|yml|yaml|lock)$/i.test(req.path)) {
        return res.status(404).type('text/plain').send('Not found');
    }
    next();
});

// Serve static frontend files
app.use(express.static(__dirname, {
    index: false,
    maxAge: IS_PRODUCTION ? '7d' : 0,
    etag: true
}));

// Friendly entry points: "/" opens the public site, "/admin" opens the CMS panel
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dr-arefin-zannat-sompa.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/voices', (req, res) => res.sendFile(path.join(__dirname, 'patient-voices.html')));
app.get('/patient-voices', (req, res) => res.sendFile(path.join(__dirname, 'patient-voices.html')));

// ==========================================
// LOGIN / SESSION (public — no database needed)
// ==========================================
app.get('/login', (req, res) => {
    if (!AUTH_ENABLED) return res.redirect('/admin');
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/api/session', (req, res) => {
    const authenticated = AUTH_ENABLED ? isLoggedIn(req) : true;
    res.json({
        success: true,
        authEnabled: AUTH_ENABLED,
        authenticated,
        username: authenticated && AUTH_ENABLED ? ADMIN_USER : null
    });
});

app.post('/api/login', requireSameOrigin, loginRateLimit, (req, res) => {
    if (!AUTH_ENABLED) {
        return res.status(400).json({ success: false, message: 'Admin sign-in is not configured on this server.' });
    }

    const { username, password, remember } = req.body || {};
    if (!safeEqual(username || '', ADMIN_USER) || !safeEqual(password || '', ADMIN_PASS)) {
        return res.status(401).json({ success: false, message: 'Wrong username or password.' });
    }

    const ttl = remember ? REMEMBER_TTL_MS : SESSION_TTL_MS;
    res.cookie(SESSION_COOKIE, createSession(ADMIN_USER, ttl), {
        httpOnly: true,
        sameSite: 'lax',
        secure: IS_PRODUCTION,
        path: '/',
        maxAge: ttl
    });
    res.json({
        success: true,
        message: remember ? 'Signed in — this device will stay signed in for 30 days.' : 'Signed in successfully.',
        expiresInHours: Math.round(ttl / 3600000)
    });
});

app.post('/api/logout', requireSameOrigin, (req, res) => {
    endSession(req); // the token is dead on the server as well, not just removed from the browser
    res.clearCookie(SESSION_COOKIE, { path: '/', sameSite: 'lax', secure: IS_PRODUCTION });
    res.json({ success: true, message: 'Signed out.' });
});

// ==========================================
// HEALTH CHECK (public)
// ==========================================
app.get('/api/health', async (req, res) => {
    const pool = await db.poolPromise;
    const dbOk = Boolean(pool);

    res.status(dbOk ? 200 : 503).json({
        success: dbOk,
        server: 'up',
        database: dbOk ? 'connected' : 'unavailable',
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

// If PostgreSQL is unreachable, answer API calls with a clear 503 instead of a
// cryptic 500 (and instead of "Cannot read properties of null").
app.use('/api', async (req, res, next) => {
    const pool = await db.poolPromise;
    if (!pool) {
        return res.status(503).json({
            success: false,
            message: 'Database is unavailable right now. Please try again in a moment.'
        });
    }
    next();
});

// ==========================================
// 1. APPOINTMENT ROUTES
// ==========================================

// Create new appointment
app.post('/api/appointments', requireSameOrigin, bookingRateLimit, async (req, res) => {
    try {
        const { name, age, phone, visit, date, slot, note } = req.body;

        const cleanName = String(name || '').trim();
        const cleanPhone = String(phone || '').trim();
        const cleanVisit = String(visit || 'First consultation').trim();
        const cleanSlot = String(slot || '').trim();
        const cleanNote = String(note || '').trim();
        const parsedAge = Number.parseInt(age, 10);
        const isoDate = /^\d{4}-\d{2}-\d{2}$/;

        if (!cleanName || !cleanPhone || !date || !cleanSlot || !Number.isInteger(parsedAge)) {
            return res.status(400).json({
                success: false,
                message: 'Please provide all required fields (name, age, phone, date, slot).'
            });
        }
        if (cleanName.length > 150 || cleanPhone.length > 30 || cleanVisit.length > 50 || cleanSlot.length > 50 || cleanNote.length > 2000) {
            return res.status(400).json({ success: false, message: 'One or more fields are too long.' });
        }
        if (parsedAge < 1 || parsedAge > 120 || !isoDate.test(String(date)) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
            return res.status(400).json({ success: false, message: 'Please provide a valid age and appointment date.' });
        }

        const pool = await db.poolPromise;
        const result = await pool.query(`
            INSERT INTO "Appointments" ("PatientName", "Age", "Phone", "VisitType", "PreferredDate", "PreferredSlot", "Notes")
            VALUES ($1, $2, $3, $4, $5::date, $6, $7)
            RETURNING "Id", "CreatedAt"
        `, [cleanName, parsedAge, cleanPhone, cleanVisit, date, cleanSlot, cleanNote || null]);

        const inserted = result.rows[0];

        res.status(201).json({
            success: true,
            message: 'Appointment request submitted successfully!',
            data: {
                id: inserted.Id,
                name: cleanName,
                age: parsedAge,
                phone: cleanPhone,
                visit: cleanVisit,
                date,
                slot: cleanSlot,
                note: cleanNote,
                status: 'Pending',
                createdAt: inserted.CreatedAt
            }
        });
    } catch (err) {
        console.error('Error creating appointment:', err);
        res.status(500).json({
            success: false,
            message: 'Database error occurred while processing appointment.'
        });
    }
});

// Get all appointments (with filters)
app.get('/api/appointments', async (req, res) => {
    try {
        const { status, date, search, from, to } = req.query;
        const pool = await db.poolPromise;

        // Validate the date filters first, so bad input gives a clear 400 instead of a SQL error
        const isoDate = /^\d{4}-\d{2}-\d{2}$/;
        for (const [name, value] of [['date', date], ['from', from], ['to', to]]) {
            if (value && !isoDate.test(String(value).trim())) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid ${name} filter. Please use the YYYY-MM-DD date format.`
                });
            }
        }

        let query = 'SELECT * FROM "Appointments" WHERE 1=1';
        const values = [];

        if (status && status !== 'All') {
            values.push(status);
            query += ` AND "Status" = $${values.length}`;
        }

        // Dates are compared as plain calendar dates, so a time-zone or format
        // difference can never make a matching appointment disappear.
        if (date) {
            values.push(String(date).trim());
            query += ` AND "PreferredDate" = $${values.length}::date`;
        }

        if (from) {
            values.push(String(from).trim());
            query += ` AND "PreferredDate" >= $${values.length}::date`;
        }

        if (to) {
            values.push(String(to).trim());
            query += ` AND "PreferredDate" <= $${values.length}::date`;
        }

        if (search) {
            values.push(`%${search}%`);
            // ILIKE keeps the case-insensitive search behaviour SQL Server's LIKE had
            query += ` AND ("PatientName" ILIKE $${values.length} OR "Phone" ILIKE $${values.length})`;
        }

        query += ' ORDER BY "PreferredDate" ASC, "CreatedAt" DESC';

        const result = await pool.query(query, values);

        res.json({
            success: true,
            count: result.rows.length,
            data: result.rows
        });
    } catch (err) {
        console.error('Error fetching appointments:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch appointments.' });
    }
});

// Update appointment status
app.patch('/api/appointments/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        const validStatuses = ['Pending', 'Confirmed', 'Completed', 'Cancelled'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status provided.' });
        }

        const pool = await db.poolPromise;
        const result = await pool.query(
            'UPDATE "Appointments" SET "Status" = $1 WHERE "Id" = $2',
            [status, Number.parseInt(id, 10)]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Appointment not found.' });
        }

        res.json({ success: true, message: `Appointment status updated to ${status}.` });
    } catch (err) {
        console.error('Error updating status:', err);
        res.status(500).json({ success: false, message: 'Failed to update appointment status.' });
    }
});

// Delete appointment
app.delete('/api/appointments/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await db.poolPromise;
        const result = await pool.query(
            'DELETE FROM "Appointments" WHERE "Id" = $1',
            [Number.parseInt(id, 10)]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Appointment not found.' });
        }

        res.json({ success: true, message: 'Appointment deleted successfully.' });
    } catch (err) {
        console.error('Error deleting appointment:', err);
        res.status(500).json({ success: false, message: 'Failed to delete appointment.' });
    }
});

// Appointment Stats
app.get('/api/stats', async (req, res) => {
    try {
        const pool = await db.poolPromise;
        const result = await pool.query(`
            SELECT
                COUNT(*)::int AS total,
                SUM(CASE WHEN "Status" = 'Pending' THEN 1 ELSE 0 END)::int AS pending,
                SUM(CASE WHEN "Status" = 'Confirmed' THEN 1 ELSE 0 END)::int AS confirmed,
                SUM(CASE WHEN "Status" = 'Completed' THEN 1 ELSE 0 END)::int AS completed,
                SUM(CASE WHEN "Status" = 'Cancelled' THEN 1 ELSE 0 END)::int AS cancelled
            FROM "Appointments"
        `);

        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (err) {
        console.error('Error fetching stats:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch statistics.' });
    }
});

// ==========================================
// 2. CMS (CONTENT MANAGEMENT) ROUTES
// ==========================================

// GET FULL WEBSITE CONTENT (Settings, Services, Testimonials, Qualifications)
app.get('/api/cms/content', async (req, res) => {
    try {
        const pool = await db.poolPromise;

        const settingsRes = await pool.query('SELECT "SettingKey", "SettingValue" FROM "SiteSettings"');
        const servicesRes = await pool.query('SELECT * FROM "Services" WHERE "IsActive" = TRUE ORDER BY "SortOrder" ASC');
        const testimonialsRes = await pool.query('SELECT * FROM "Testimonials" WHERE "IsActive" = TRUE ORDER BY "SortOrder" ASC');
        const qualificationsRes = await pool.query('SELECT * FROM "Qualifications" ORDER BY "SortOrder" ASC');

        const settingsMap = {};
        settingsRes.rows.forEach(item => {
            settingsMap[item.SettingKey] = item.SettingValue;
        });

        res.json({
            success: true,
            data: {
                settings: settingsMap,
                services: servicesRes.rows,
                testimonials: testimonialsRes.rows,
                qualifications: qualificationsRes.rows
            }
        });
    } catch (err) {
        console.error('Error fetching CMS content:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch CMS content.' });
    }
});

// UPDATE SITE SETTINGS (Profile, Contact Info, Bio, etc.)
app.put('/api/cms/settings', async (req, res) => {
    try {
        const settings = req.body; // Key-Value object
        const pool = await db.poolPromise;

        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
            return res.status(400).json({ success: false, message: 'Send a JSON object of settingKey → value pairs.' });
        }

        const entries = Object.entries(settings).map(([key, value]) => [
            key,
            value === undefined || value === null ? '' : String(value)
        ]);

        // Image uploads arrive as data URLs — make sure nothing else is smuggled in
        const badValue = entries.find(([, value]) => value.startsWith('data:') && !/^data:image\//i.test(value));
        if (badValue) {
            return res.status(400).json({
                success: false,
                message: `"${badValue[0]}" must be an uploaded image file.`
            });
        }

        for (const [key, value] of entries) {
            // PostgreSQL's own upsert replaces the old IF EXISTS / ELSE pair
            await pool.query(`
                INSERT INTO "SiteSettings" ("SettingKey", "SettingValue")
                VALUES ($1, $2)
                ON CONFLICT ("SettingKey") DO UPDATE
                    SET "SettingValue" = EXCLUDED."SettingValue", "UpdatedAt" = NOW()
            `, [key, value]);
        }

        res.json({ success: true, message: 'Site settings updated successfully!' });
    } catch (err) {
        console.error('Error updating site settings:', err);
        res.status(500).json({ success: false, message: 'Failed to update site settings.' });
    }
});

// SERVICES CRUD
app.get('/api/cms/services/all', async (req, res) => {
    try {
        const pool = await db.poolPromise;
        const result = await pool.query('SELECT * FROM "Services" ORDER BY "SortOrder" ASC');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to fetch services.' });
    }
});

app.post('/api/cms/services', async (req, res) => {
    try {
        const { title, description, sortOrder, isActive } = req.body;
        const pool = await db.poolPromise;
        await pool.query(
            'INSERT INTO "Services" ("Title", "Description", "SortOrder", "IsActive") VALUES ($1, $2, $3, $4)',
            [title, description, Number.parseInt(sortOrder, 10) || 0, toBool(isActive)]
        );
        res.status(201).json({ success: true, message: 'Service added successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to add service.' });
    }
});

app.put('/api/cms/services/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, sortOrder, isActive } = req.body;
        const pool = await db.poolPromise;
        await pool.query(
            'UPDATE "Services" SET "Title" = $1, "Description" = $2, "SortOrder" = $3, "IsActive" = $4 WHERE "Id" = $5',
            [title, description, Number.parseInt(sortOrder, 10) || 0, toBool(isActive), Number.parseInt(id, 10)]
        );
        res.json({ success: true, message: 'Service updated successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update service.' });
    }
});

app.delete('/api/cms/services/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await db.poolPromise;
        await pool.query('DELETE FROM "Services" WHERE "Id" = $1', [Number.parseInt(id, 10)]);
        res.json({ success: true, message: 'Service deleted successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to delete service.' });
    }
});

// TESTIMONIALS CRUD
app.get('/api/cms/testimonials/all', async (req, res) => {
    try {
        const pool = await db.poolPromise;
        const result = await pool.query('SELECT * FROM "Testimonials" ORDER BY "SortOrder" ASC');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to fetch testimonials.' });
    }
});

app.post('/api/cms/testimonials', async (req, res) => {
    try {
        const { quote, author, sortOrder, isActive } = req.body;
        const pool = await db.poolPromise;
        await pool.query(
            'INSERT INTO "Testimonials" ("Quote", "Author", "SortOrder", "IsActive") VALUES ($1, $2, $3, $4)',
            [quote, author, Number.parseInt(sortOrder, 10) || 0, toBool(isActive)]
        );
        res.status(201).json({ success: true, message: 'Testimonial added successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to add testimonial.' });
    }
});

app.put('/api/cms/testimonials/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { quote, author, sortOrder, isActive } = req.body;
        const pool = await db.poolPromise;
        await pool.query(
            'UPDATE "Testimonials" SET "Quote" = $1, "Author" = $2, "SortOrder" = $3, "IsActive" = $4 WHERE "Id" = $5',
            [quote, author, Number.parseInt(sortOrder, 10) || 0, toBool(isActive), Number.parseInt(id, 10)]
        );
        res.json({ success: true, message: 'Testimonial updated successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update testimonial.' });
    }
});

app.delete('/api/cms/testimonials/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await db.poolPromise;
        await pool.query('DELETE FROM "Testimonials" WHERE "Id" = $1', [Number.parseInt(id, 10)]);
        res.json({ success: true, message: 'Testimonial deleted successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to delete testimonial.' });
    }
});

// QUALIFICATIONS CRUD
app.get('/api/cms/qualifications/all', async (req, res) => {
    try {
        const pool = await db.poolPromise;
        const result = await pool.query('SELECT * FROM "Qualifications" ORDER BY "SortOrder" ASC');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to fetch qualifications.' });
    }
});

app.put('/api/cms/qualifications/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, subtext } = req.body;
        const pool = await db.poolPromise;
        await pool.query(
            'UPDATE "Qualifications" SET "Title" = $1, "Description" = $2, "Subtext" = $3 WHERE "Id" = $4',
            [title, description, subtext, Number.parseInt(id, 10)]
        );
        res.json({ success: true, message: 'Qualification card updated successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update qualification card.' });
    }
});

// ==========================================
// 3. PATIENT REMINDERS (SMS + e-mail digest)
// ==========================================

// Every channel stays switched off until it is configured in .env, so the feature is
// safe by default: the panel still shows the ready-to-send messages (copy / call / mark
// as reminded) and only sends for real once a gateway or SMTP server is provided.
const SMS_API_URL = (process.env.SMS_API_URL || '').trim();
const SMS_API_KEY = (process.env.SMS_API_KEY || '').trim();
const SMS_AUTH_HEADER = (process.env.SMS_AUTH_HEADER || 'Authorization').trim();
const SMS_AUTH_SCHEME = (process.env.SMS_AUTH_SCHEME || 'Bearer').trim();
const SMS_METHOD = (process.env.SMS_METHOD || 'GET').trim().toUpperCase();
const SMTP_HOST = (process.env.SMTP_HOST || '').trim();
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = (process.env.SMTP_FROM || '').trim();
const CLINIC_EMAIL = (process.env.CLINIC_EMAIL || SMTP_USER).trim();
const REMINDER_DRY_RUN = process.env.REMINDER_DRY_RUN === 'true';

const SMS_ENABLED = Boolean(SMS_API_URL);
const EMAIL_ENABLED = Boolean(SMTP_HOST && SMTP_FROM);

const DEFAULT_REMINDER_TEMPLATE =
    'প্রিয় {name}, আপনার অ্যাপয়েন্টমেন্ট {relative} ({date}, {slot}) — {doctor}। সময় বদলাতে হলে {phone} নম্বরে জানান।';

const BN_MONTHS = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন',
                   'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'];

function toBanglaDigits(value) {
    return String(value).replace(/[0-9]/g, d => '০১২৩৪৫৬৭৮৯'[Number(d)]);
}

function banglaDate(isoDate) {
    const m = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(isoDate || '');
    return `${toBanglaDigits(Number(m[3]))} ${BN_MONTHS[Number(m[2]) - 1]} ${toBanglaDigits(m[1])}`;
}

// Calendar date in the server's own time zone (never an ISO slice, which can shift a day)
function localIsoDate(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() + (offsetDays || 0));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function composeReminder(appointment, settings, isoDate) {
    const template = (process.env.REMINDER_TEMPLATE || DEFAULT_REMINDER_TEMPLATE).replace(/\\n/g, '\n');
    const relative = isoDate === localIsoDate(0) ? 'আজ' : (isoDate === localIsoDate(1) ? 'আগামীকাল' : '');
    return template
        .replace(/\{name\}/g, appointment.PatientName || '')
        .replace(/\{age\}/g, appointment.Age || '')
        .replace(/\{relative\}/g, relative)
        .replace(/\{date\}/g, banglaDate(isoDate))
        .replace(/\{date_en\}/g, isoDate)
        .replace(/\{slot\}/g, appointment.PreferredSlot || '')
        .replace(/\{doctor\}/g, (settings && settings.doctor_name) || 'Dr. Arefin Zannat Sompa')
        .replace(/\{chamber\}/g, (settings && settings.chamber_address) || 'সিলেট')
        .replace(/\{phone\}/g, (settings && settings.phone) || '')
        .replace(/\{email\}/g, (settings && settings.email) || '')
        .replace(/[ \t]{2,}/g, ' ')   // collapse the gap left by an empty {relative}
        .trim();
}

// The reminder history table is created on first use, so an existing database
// does not need a manual SQL step.
let reminderTableReady = false;
async function ensureReminderTable(pool) {
    if (reminderTableReady) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS "ReminderLog" (
            "Id"            INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            "AppointmentId" INTEGER NOT NULL,
            "Channel"       VARCHAR(20) NOT NULL,
            "Destination"   VARCHAR(200) NOT NULL,
            "Message"       TEXT NOT NULL,
            "Status"        VARCHAR(20) NOT NULL,
            "Error"         TEXT NULL,
            "SentAt"        TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);
    reminderTableReady = true;
}

async function readSettings(pool) {
    const result = await pool.query('SELECT "SettingKey", "SettingValue" FROM "SiteSettings"');
    const settings = {};
    result.rows.forEach(row => { settings[row.SettingKey] = row.SettingValue; });
    return settings;
}

async function logReminder(pool, { appointmentId, channel, destination, message, status, error }) {
    await pool.query(`
        INSERT INTO "ReminderLog" ("AppointmentId", "Channel", "Destination", "Message", "Status", "Error")
        VALUES ($1, $2, $3, $4, $5, $6)
    `, [appointmentId, channel, destination || '', message || '', status, error || null]);
}

// ---------------------------------------------------------------------------
// Delivery: SMS through a generic HTTP gateway, e-mail through SMTP
// ---------------------------------------------------------------------------

// GET  → {phone} / {message} inside SMS_API_URL are replaced (message URL-encoded);
//        if the URL has no placeholder, ?to=...&message=... is appended.
// POST → JSON body { to, message } is posted to SMS_API_URL.
async function sendSms(phone, message) {
    if (!SMS_ENABLED) {
        throw new Error('SMS is not configured on this server — set SMS_API_URL in .env.');
    }
    if (REMINDER_DRY_RUN) {
        return { response: 'dry run — no SMS was sent' };
    }

    const headers = { Accept: 'application/json' };
    if (SMS_API_KEY) {
        headers[SMS_AUTH_HEADER] = `${SMS_AUTH_SCHEME} ${SMS_API_KEY}`.trim();
    }

    let url = SMS_API_URL;
    const options = { method: SMS_METHOD, headers, signal: AbortSignal.timeout(20000) };

    if (SMS_METHOD === 'POST') {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify({ to: phone, message });
    } else {
        const hasPlaceholder = /\{phone\}/.test(SMS_API_URL) || /\{message\}/.test(SMS_API_URL);
        url = SMS_API_URL
            .replace(/\{phone\}/g, encodeURIComponent(phone))
            .replace(/\{message\}/g, encodeURIComponent(message));
        if (!hasPlaceholder) {
            const sep = url.includes('?') ? '&' : '?';
            url += `${sep}to=${encodeURIComponent(phone)}&message=${encodeURIComponent(message)}`;
        }
    }

    const res = await fetch(url, options);
    const text = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 300);

    if (!res.ok) {
        throw new Error(`SMS gateway replied HTTP ${res.status}${text ? ' — ' + text : ''}`);
    }
    return { response: text || `HTTP ${res.status}` };
}

let _mailer = null;
function getMailer() {
    if (!EMAIL_ENABLED) {
        throw new Error('E-mail is not configured on this server — set SMTP_HOST and SMTP_FROM in .env.');
    }
    if (!_mailer) {
        let nodemailer;
        try {
            nodemailer = require('nodemailer');
        } catch (err) {
            throw new Error('The "nodemailer" package is missing. Install it with: npm.cmd install nodemailer');
        }
        _mailer = nodemailer.createTransport({
            host: SMTP_HOST,
            port: SMTP_PORT,
            secure: SMTP_SECURE,
            auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
        });
    }
    return _mailer;
}

function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildDigestEmail(isoDate, appointments) {
    const rows = appointments.map(a => `
        <tr>
            <td>${escapeHtml(a.PreferredSlot)}</td>
            <td><b>${escapeHtml(a.PatientName)}</b></td>
            <td>${escapeHtml(a.Age)}</td>
            <td>${escapeHtml(a.Phone)}</td>
            <td>${escapeHtml(a.VisitType)}</td>
            <td>${escapeHtml(a.Status)}</td>
        </tr>`).join('');

    const subject = `Chamber list — ${isoDate} (${appointments.length} appointment${appointments.length === 1 ? '' : 's'})`;
    const html = `
        <div style="font-family:Karla,Arial,sans-serif;color:#18202E">
            <h2 style="color:#0E2452;margin:0 0 .2rem">Chamber list — ${escapeHtml(isoDate)}</h2>
            <p style="color:#5B6678;margin:.2rem 0 1rem">${appointments.length} appointment${appointments.length === 1 ? '' : 's'} scheduled.</p>
            <table cellspacing="0" cellpadding="8" style="border-collapse:collapse;width:100%;font-size:14px">
                <thead>
                    <tr style="background:#0E2452;color:#fff;text-align:left">
                        <th>Slot</th><th>Patient</th><th>Age</th><th>Phone</th><th>Visit</th><th>Status</th>
                    </tr>
                </thead>
                <tbody>${rows || '<tr><td colspan="6">No appointments.</td></tr>'}</tbody>
            </table>
        </div>`;

    const text = [`Chamber list — ${isoDate}`, '', ...appointments.map(a =>
        `${a.PreferredSlot} | ${a.PatientName} (${a.Age}) | ${a.Phone} | ${a.VisitType} | ${a.Status}`)].join('\n');

    return { subject, html, text };
}

function resolveReminderDate(when) {
    const value = String(when === undefined || when === null || when === '' ? 'tomorrow' : when).trim();
    if (value === 'today') return localIsoDate(0);
    if (value === 'tomorrow') return localIsoDate(1);
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

// Who needs a reminder for a given day, with the ready-to-send message
app.get('/api/reminders/due', async (req, res) => {
    try {
        const pool = await db.poolPromise;
        await ensureReminderTable(pool);

        const isoDate = resolveReminderDate(req.query.when);
        if (!isoDate) {
            return res.status(400).json({ success: false, message: 'Use when=today, when=tomorrow or a YYYY-MM-DD date.' });
        }

        const result = await pool.query(`
            SELECT a."Id", a."PatientName", a."Age", a."Phone", a."VisitType", a."PreferredDate",
                   a."PreferredSlot", a."Status", a."Notes",
                   last."Channel" AS "LastChannel", last."Status" AS "LastStatus", last."SentAt" AS "LastSentAt"
            FROM "Appointments" a
            LEFT JOIN LATERAL (
                SELECT "Channel", "Status", "SentAt"
                FROM "ReminderLog"
                WHERE "AppointmentId" = a."Id" AND "Status" IN ('sent', 'manual', 'dry-run')
                ORDER BY "SentAt" DESC
                LIMIT 1
            ) AS last ON TRUE
            WHERE a."PreferredDate" = $1::date
              AND a."Status" <> 'Cancelled'
            ORDER BY a."PreferredSlot" ASC, a."Id" ASC
        `, [isoDate]);

        const settings = await readSettings(pool);
        const data = result.rows.map(row => ({
            id: row.Id,
            name: row.PatientName,
            age: row.Age,
            phone: row.Phone,
            visit: row.VisitType,
            date: String(row.PreferredDate).slice(0, 10),
            slot: row.PreferredSlot,
            status: row.Status,
            notes: row.Notes || '',
            message: composeReminder(row, settings, isoDate),
            lastReminder: row.LastSentAt
                ? { channel: row.LastChannel, status: row.LastStatus, sentAt: row.LastSentAt }
                : null
        }));

        res.json({
            success: true,
            when: isoDate,
            count: data.length,
            pending: data.filter(item => !item.lastReminder).length,
            channels: { sms: SMS_ENABLED, email: EMAIL_ENABLED, dryRun: REMINDER_DRY_RUN },
            clinicEmail: CLINIC_EMAIL || null,
            data
        });
    } catch (err) {
        console.error('Error loading reminders:', err);
        res.status(500).json({ success: false, message: 'Failed to load reminders.' });
    }
});

// Send (or preview, when REMINDER_DRY_RUN=true) one SMS reminder
app.post('/api/reminders/send', async (req, res) => {
    try {
        const pool = await db.poolPromise;
        await ensureReminderTable(pool);

        const id = parseInt((req.body || {}).appointmentId, 10);
        if (!id) {
            return res.status(400).json({ success: false, message: 'appointmentId is required.' });
        }

        const found = await pool.query('SELECT * FROM "Appointments" WHERE "Id" = $1', [id]);
        if (!found.rows.length) {
            return res.status(404).json({ success: false, message: 'Appointment not found.' });
        }

        const appointment = found.rows[0];
        const isoDate = String(appointment.PreferredDate).slice(0, 10);
        const settings = await readSettings(pool);
        const reminderText = composeReminder(appointment, settings, isoDate);
        const phone = String(appointment.Phone || '').trim();

        let status = 'sent';
        let detail = '';

        if (!phone) {
            status = 'failed';
            detail = 'This appointment has no phone number.';
        } else {
            try {
                const result = await sendSms(phone, reminderText);
                if (REMINDER_DRY_RUN) status = 'dry-run';
                detail = result.response;
            } catch (err) {
                status = 'failed';
                detail = err.message;
            }
        }

        await logReminder(pool, {
            appointmentId: id,
            channel: 'sms',
            destination: phone,
            message: reminderText,
            status,
            error: status === 'failed' ? detail : null
        });

        if (status === 'failed') {
            return res.status(502).json({ success: false, status, message: `SMS not sent: ${detail}`, reminder: reminderText });
        }

        res.json({
            success: true,
            status,
            message: status === 'dry-run'
                ? `Dry run — the reminder for ${appointment.PatientName} was prepared but not sent.`
                : `Reminder sent to ${phone}.`,
            reminder: reminderText
        });
    } catch (err) {
        console.error('Error sending reminder:', err);
        res.status(500).json({ success: false, message: 'Failed to send the reminder.' });
    }
});

// Record a reminder that was given by phone / in person, so it is not repeated
app.post('/api/reminders/mark', async (req, res) => {
    try {
        const pool = await db.poolPromise;
        await ensureReminderTable(pool);

        const id = parseInt((req.body || {}).appointmentId, 10);
        if (!id) {
            return res.status(400).json({ success: false, message: 'appointmentId is required.' });
        }

        const found = await pool.query('SELECT * FROM "Appointments" WHERE "Id" = $1', [id]);
        if (!found.rows.length) {
            return res.status(404).json({ success: false, message: 'Appointment not found.' });
        }

        const appointment = found.rows[0];
        const settings = await readSettings(pool);
        const reminderText = composeReminder(appointment, settings, String(appointment.PreferredDate).slice(0, 10));

        await logReminder(pool, {
            appointmentId: id,
            channel: String((req.body || {}).channel || 'manual').slice(0, 20),
            destination: appointment.Phone,
            message: reminderText,
            status: 'manual',
            error: null
        });

        res.json({ success: true, message: `Marked as reminded (${appointment.PatientName}).` });
    } catch (err) {
        console.error('Error marking reminder:', err);
        res.status(500).json({ success: false, message: 'Failed to record the reminder.' });
    }
});

// E-mail the day's chamber list to the clinic address
app.post('/api/reminders/email-digest', async (req, res) => {
    try {
        const pool = await db.poolPromise;
        await ensureReminderTable(pool);

        const isoDate = resolveReminderDate((req.body || {}).when);
        if (!isoDate) {
            return res.status(400).json({ success: false, message: 'Use when=today, when=tomorrow or a YYYY-MM-DD date.' });
        }

        const result = await pool.query(`
            SELECT "PatientName", "Age", "Phone", "VisitType", "PreferredSlot", "Status"
            FROM "Appointments"
            WHERE "PreferredDate" = $1::date AND "Status" <> 'Cancelled'
            ORDER BY "PreferredSlot" ASC, "Id" ASC
        `, [isoDate]);

        const appointments = result.rows;
        const { subject, html, text } = buildDigestEmail(isoDate, appointments);
        const to = String((req.body || {}).to || CLINIC_EMAIL || '').trim();

        if (!to) {
            return res.status(400).json({
                success: false,
                message: 'No destination address. Set CLINIC_EMAIL (or SMTP_USER) in .env, or pass "to" in the request.'
            });
        }

        if (REMINDER_DRY_RUN) {
            await logReminder(pool, {
                appointmentId: 0, channel: 'email', destination: to,
                message: `${subject}\n\n${text}`, status: 'dry-run', error: null
            });
            return res.json({
                success: true,
                status: 'dry-run',
                message: `Dry run — the list for ${isoDate} (${appointments.length} appointments) was prepared for ${to} but not sent.`
            });
        }

        try {
            const info = await getMailer().sendMail({ from: SMTP_FROM, to, subject, text, html });
            await logReminder(pool, {
                appointmentId: 0, channel: 'email', destination: to,
                message: `${subject}\n\n${text}`, status: 'sent', error: null
            });
            res.json({
                success: true,
                status: 'sent',
                message: `List for ${isoDate} e-mailed to ${to} (${appointments.length} appointments).`,
                messageId: info && info.messageId
            });
        } catch (mailErr) {
            await logReminder(pool, {
                appointmentId: 0, channel: 'email', destination: to,
                message: subject, status: 'failed', error: mailErr.message
            });
            res.status(502).json({ success: false, message: `E-mail not sent: ${mailErr.message}` });
        }
    } catch (err) {
        console.error('Error e-mailing the digest:', err);
        res.status(500).json({ success: false, message: 'Failed to e-mail the chamber list.' });
    }
});

// Reminder history
app.get('/api/reminders/log', async (req, res) => {
    try {
        const pool = await db.poolPromise;
        await ensureReminderTable(pool);

        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
        const result = await pool.query(`
            SELECT r."Id", r."AppointmentId", r."Channel", r."Destination", r."Message",
                   r."Status", r."Error", r."SentAt", a."PatientName", a."PreferredDate"
            FROM "ReminderLog" r
            LEFT JOIN "Appointments" a ON a."Id" = r."AppointmentId"
            ORDER BY r."SentAt" DESC, r."Id" DESC
            LIMIT $1
        `, [limit]);

        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('Error loading reminder log:', err);
        res.status(500).json({ success: false, message: 'Failed to load the reminder history.' });
    }
});

// Unknown API endpoint → JSON response (keeps the frontend's res.json() from throwing)
app.use('/api', (req, res) => {
    res.status(404).json({
        success: false,
        message: `Unknown API endpoint: ${req.method} ${req.originalUrl}`
    });
});

app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ success: false, message: 'Request is too large.' });
    }
    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({ success: false, message: 'Invalid JSON request body.' });
    }
    if (err && err.message === 'Origin is not allowed by CORS.') {
        return res.status(403).json({ success: false, message: 'This request origin is not allowed.' });
    }
    console.error('Unhandled request error:', err);
    res.status(500).json({ success: false, message: 'An unexpected server error occurred.' });
});

// Start Express server
const server = app.listen(PORT, () => {
    config.logSummary();
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`   Website : http://localhost:${PORT}/`);
    console.log(`   CMS     : http://localhost:${PORT}/admin`);
    console.log(`   Health  : http://localhost:${PORT}/api/health`);
    console.log(AUTH_ENABLED
        ? `🔒 Admin sign-in: ENABLED (user "${ADMIN_USER}") — ${AUTH_ENABLED ? 'http://localhost:' + PORT + '/login' : ''}`
        : '🔓 Admin sign-in: disabled (set Admin:User + Admin:Password in appsettings.json to enable)');

    // A brand-new database (fresh hosting account, new laptop) gets its tables and
    // sample content straight away. setup_db.sql is idempotent, so an existing
    // database is never changed — switch this off with DB_AUTO_MIGRATE=false.
    if (process.env.DB_AUTO_MIGRATE !== 'false') db.ensureSchema();
});

let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received — shutting down gracefully.`);
    server.close(async () => {
        await db.close();
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
