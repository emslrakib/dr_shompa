const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// DB module is lazy-loaded — connect() only happens when a route handler calls await db.poolPromise
// This ensures require() does NOT block server startup
const db = require('./db');
// `sql` is mssql's data-type namespace (NVarChar, Int, Bit, ...) — importing it does NOT open a connection
const sql = db.sql;
// Make db available in all route handlers via express locals as well
app.use((req, res, next) => {
    req.db = db;
    next();
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Serve static frontend files
app.use(express.static(__dirname));

// Friendly entry points: "/" opens the public site, "/admin" opens the CMS panel
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dr-arefin-zannat-sompa.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/voices', (req, res) => res.sendFile(path.join(__dirname, 'patient-voices.html')));
app.get('/patient-voices', (req, res) => res.sendFile(path.join(__dirname, 'patient-voices.html')));

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
        const { status, date, search } = req.query;
        const pool = await db.poolPromise;
        let query = 'SELECT * FROM Appointments WHERE 1=1';

        const request = pool.request();

        if (status && status !== 'All') {
            query += ' AND Status = @Status';
            request.input('Status', sql.NVarChar(30), status);
        }

        if (date) {
            query += ' AND PreferredDate = @PreferredDate';
            request.input('PreferredDate', sql.Date, date);
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

        for (const [key, value] of Object.entries(settings)) {
            await pool.request()
                .input('SettingKey', sql.NVarChar(100), key)
                .input('SettingValue', sql.NVarChar(sql.MAX), String(value || ''))
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

// Start Express server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
