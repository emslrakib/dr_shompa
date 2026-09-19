const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// DB module is lazy-loaded — connect() only happens when a route handler calls await db.poolPromise
// This ensures require() does NOT block server startup
const db = require('./db');
// `sql` is mssql's data-type namespace (NVarChar, Int, Bit, ...) — importing it does NOT open a connection
const sql = db.sql;

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
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // an 8 hour working session
const SESSION_SECRET = process.env.SESSION_SECRET
    || crypto.createHash('sha256').update(`${ADMIN_USER}:${ADMIN_PASS}:drshompa`).digest('hex');

function safeEqual(a, b) {
    const bufA = Buffer.from(String(a), 'utf8');
    const bufB = Buffer.from(String(b), 'utf8');
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
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

function createSession(username) {
    pruneExpiredSessions();
    const sid = crypto.randomBytes(18).toString('base64url');
    const exp = Date.now() + SESSION_TTL_MS;
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

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

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
app.use(express.static(__dirname));

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

app.post('/api/login', (req, res) => {
    if (!AUTH_ENABLED) {
        return res.status(400).json({ success: false, message: 'Admin sign-in is not configured on this server.' });
    }

    const { username, password } = req.body || {};
    if (!safeEqual(username || '', ADMIN_USER) || !safeEqual(password || '', ADMIN_PASS)) {
        return res.status(401).json({ success: false, message: 'Wrong username or password.' });
    }

    res.cookie(SESSION_COOKIE, createSession(ADMIN_USER), {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_TTL_MS
    });
    res.json({ success: true, message: 'Signed in successfully.' });
});

app.post('/api/logout', (req, res) => {
    endSession(req); // the token is dead on the server as well, not just removed from the browser
    res.clearCookie(SESSION_COOKIE, { path: '/' });
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
        databaseName: process.env.DB_NAME,
        adminAuth: AUTH_ENABLED ? 'enabled' : 'disabled',
        node: process.version,
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

// If SQL Server is unreachable, answer API calls with a clear 503 instead of a
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
app.post('/api/appointments', async (req, res) => {
    try {
        const { name, age, phone, visit, date, slot, note } = req.body;

        if (!name || !age || !phone || !date || !slot) {
            return res.status(400).json({
                success: false,
                message: 'Please provide all required fields (name, age, phone, date, slot).'
            });
        }

        const pool = await db.poolPromise;
        const result = await pool.request()
            .input('PatientName', sql.NVarChar(150), name)
            .input('Age', sql.Int, parseInt(age))
            .input('Phone', sql.NVarChar(30), phone)
            .input('VisitType', sql.NVarChar(50), visit || 'First consultation')
            .input('PreferredDate', sql.Date, date)
            .input('PreferredSlot', sql.NVarChar(50), slot)
            .input('Notes', sql.NVarChar(sql.MAX), note || null)
            .query(`
                INSERT INTO Appointments (PatientName, Age, Phone, VisitType, PreferredDate, PreferredSlot, Notes)
                OUTPUT INSERTED.Id, INSERTED.CreatedAt
                VALUES (@PatientName, @Age, @Phone, @VisitType, @PreferredDate, @PreferredSlot, @Notes)
            `);

        const inserted = result.recordset[0];

        res.status(201).json({
            success: true,
            message: 'Appointment request submitted successfully!',
            data: {
                id: inserted.Id,
                name,
                age,
                phone,
                visit,
                date,
                slot,
                note,
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

        let query = 'SELECT * FROM Appointments WHERE 1=1';

        const request = pool.request();

        if (status && status !== 'All') {
            query += ' AND Status = @Status';
            request.input('Status', sql.NVarChar(30), status);
        }

        // Dates are compared as plain calendar dates, so a time-zone or format
        // difference can never make a matching appointment disappear.
        if (date) {
            query += ' AND CAST(PreferredDate AS date) = CAST(@FilterDate AS date)';
            request.input('FilterDate', sql.NVarChar(10), String(date).trim());
        }

        if (from) {
            query += ' AND CAST(PreferredDate AS date) >= CAST(@DateFrom AS date)';
            request.input('DateFrom', sql.NVarChar(10), String(from).trim());
        }

        if (to) {
            query += ' AND CAST(PreferredDate AS date) <= CAST(@DateTo AS date)';
            request.input('DateTo', sql.NVarChar(10), String(to).trim());
        }

        if (search) {
            query += ' AND (PatientName LIKE @Search OR Phone LIKE @Search)';
            request.input('Search', sql.NVarChar(100), `%${search}%`);
        }

        query += ' ORDER BY PreferredDate ASC, CreatedAt DESC';

        const result = await request.query(query);

        res.json({
            success: true,
            count: result.recordset.length,
            data: result.recordset
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
        const result = await pool.request()
            .input('Id', sql.Int, parseInt(id))
            .input('Status', sql.NVarChar(30), status)
            .query('UPDATE Appointments SET Status = @Status WHERE Id = @Id');

        if (result.rowsAffected[0] === 0) {
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
        const result = await pool.request()
            .input('Id', sql.Int, parseInt(id))
            .query('DELETE FROM Appointments WHERE Id = @Id');

        if (result.rowsAffected[0] === 0) {
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
        const result = await pool.request().query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN Status = 'Pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN Status = 'Confirmed' THEN 1 ELSE 0 END) as confirmed,
                SUM(CASE WHEN Status = 'Completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN Status = 'Cancelled' THEN 1 ELSE 0 END) as cancelled
            FROM Appointments
        `);

        res.json({
            success: true,
            data: result.recordset[0]
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

        const settingsRes = await pool.request().query('SELECT SettingKey, SettingValue FROM SiteSettings');
        const servicesRes = await pool.request().query('SELECT * FROM Services WHERE IsActive = 1 ORDER BY SortOrder ASC');
        const testimonialsRes = await pool.request().query('SELECT * FROM Testimonials WHERE IsActive = 1 ORDER BY SortOrder ASC');
        const qualificationsRes = await pool.request().query('SELECT * FROM Qualifications ORDER BY SortOrder ASC');

        const settingsMap = {};
        settingsRes.recordset.forEach(item => {
            settingsMap[item.SettingKey] = item.SettingValue;
        });

        res.json({
            success: true,
            data: {
                settings: settingsMap,
                services: servicesRes.recordset,
                testimonials: testimonialsRes.recordset,
                qualifications: qualificationsRes.recordset
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
            await pool.request()
                .input('SettingKey', sql.NVarChar(100), key)
                .input('SettingValue', sql.NVarChar(sql.MAX), value)
                .query(`
                    IF EXISTS (SELECT 1 FROM SiteSettings WHERE SettingKey = @SettingKey)
                        UPDATE SiteSettings SET SettingValue = @SettingValue, UpdatedAt = GETDATE() WHERE SettingKey = @SettingKey
                    ELSE
                        INSERT INTO SiteSettings (SettingKey, SettingValue) VALUES (@SettingKey, @SettingValue)
                `);
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
        const result = await pool.request().query('SELECT * FROM Services ORDER BY SortOrder ASC');
        res.json({ success: true, data: result.recordset });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to fetch services.' });
    }
});

app.post('/api/cms/services', async (req, res) => {
    try {
        const { title, description, sortOrder, isActive } = req.body;
        const pool = await db.poolPromise;
        await pool.request()
            .input('Title', sql.NVarChar(150), title)
            .input('Description', sql.NVarChar(sql.MAX), description)
            .input('SortOrder', sql.Int, parseInt(sortOrder) || 0)
            .input('IsActive', sql.Bit, isActive !== undefined ? isActive : 1)
            .query('INSERT INTO Services (Title, Description, SortOrder, IsActive) VALUES (@Title, @Description, @SortOrder, @IsActive)');
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
        await pool.request()
            .input('Id', sql.Int, parseInt(id))
            .input('Title', sql.NVarChar(150), title)
            .input('Description', sql.NVarChar(sql.MAX), description)
            .input('SortOrder', sql.Int, parseInt(sortOrder) || 0)
            .input('IsActive', sql.Bit, isActive !== undefined ? isActive : 1)
            .query('UPDATE Services SET Title = @Title, Description = @Description, SortOrder = @SortOrder, IsActive = @IsActive WHERE Id = @Id');
        res.json({ success: true, message: 'Service updated successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update service.' });
    }
});

app.delete('/api/cms/services/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await db.poolPromise;
        await pool.request().input('Id', sql.Int, parseInt(id)).query('DELETE FROM Services WHERE Id = @Id');
        res.json({ success: true, message: 'Service deleted successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to delete service.' });
    }
});

// TESTIMONIALS CRUD
app.get('/api/cms/testimonials/all', async (req, res) => {
    try {
        const pool = await db.poolPromise;
        const result = await pool.request().query('SELECT * FROM Testimonials ORDER BY SortOrder ASC');
        res.json({ success: true, data: result.recordset });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to fetch testimonials.' });
    }
});

app.post('/api/cms/testimonials', async (req, res) => {
    try {
        const { quote, author, sortOrder, isActive } = req.body;
        const pool = await db.poolPromise;
        await pool.request()
            .input('Quote', sql.NVarChar(sql.MAX), quote)
            .input('Author', sql.NVarChar(150), author)
            .input('SortOrder', sql.Int, parseInt(sortOrder) || 0)
            .input('IsActive', sql.Bit, isActive !== undefined ? isActive : 1)
            .query('INSERT INTO Testimonials (Quote, Author, SortOrder, IsActive) VALUES (@Quote, @Author, @SortOrder, @IsActive)');
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
        await pool.request()
            .input('Id', sql.Int, parseInt(id))
            .input('Quote', sql.NVarChar(sql.MAX), quote)
            .input('Author', sql.NVarChar(150), author)
            .input('SortOrder', sql.Int, parseInt(sortOrder) || 0)
            .input('IsActive', sql.Bit, isActive !== undefined ? isActive : 1)
            .query('UPDATE Testimonials SET Quote = @Quote, Author = @Author, SortOrder = @SortOrder, IsActive = @IsActive WHERE Id = @Id');
        res.json({ success: true, message: 'Testimonial updated successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update testimonial.' });
    }
});

app.delete('/api/cms/testimonials/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await db.poolPromise;
        await pool.request().input('Id', sql.Int, parseInt(id)).query('DELETE FROM Testimonials WHERE Id = @Id');
        res.json({ success: true, message: 'Testimonial deleted successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to delete testimonial.' });
    }
});

// QUALIFICATIONS CRUD
app.get('/api/cms/qualifications/all', async (req, res) => {
    try {
        const pool = await db.poolPromise;
        const result = await pool.request().query('SELECT * FROM Qualifications ORDER BY SortOrder ASC');
        res.json({ success: true, data: result.recordset });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to fetch qualifications.' });
    }
});

app.put('/api/cms/qualifications/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, subtext } = req.body;
        const pool = await db.poolPromise;
        await pool.request()
            .input('Id', sql.Int, parseInt(id))
            .input('Title', sql.NVarChar(150), title)
            .input('Description', sql.NVarChar(sql.MAX), description)
            .input('Subtext', sql.NVarChar(150), subtext)
            .query('UPDATE Qualifications SET Title = @Title, Description = @Description, Subtext = @Subtext WHERE Id = @Id');
        res.json({ success: true, message: 'Qualification card updated successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update qualification card.' });
    }
});

// Unknown API endpoint → JSON response (keeps the frontend's res.json() from throwing)
app.use('/api', (req, res) => {
    res.status(404).json({
        success: false,
        message: `Unknown API endpoint: ${req.method} ${req.originalUrl}`
    });
});

// Start Express server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`   Website : http://localhost:${PORT}/`);
    console.log(`   CMS     : http://localhost:${PORT}/admin`);
    console.log(`   Health  : http://localhost:${PORT}/api/health`);
    console.log(AUTH_ENABLED
        ? `🔒 Admin sign-in: ENABLED (user "${ADMIN_USER}") — ${AUTH_ENABLED ? 'http://localhost:' + PORT + '/login' : ''}`
        : '🔓 Admin sign-in: disabled (set ADMIN_USER + ADMIN_PASS in .env to enable)');
});
