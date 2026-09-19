const sql = require('mssql');
require('dotenv').config();

const dbConfig = {
    server: process.env.DB_SERVER || 'localhost',
    database: process.env.DB_NAME || 'DrShompaDB',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT) || 1433,
    options: {
        encrypt: process.env.DB_ENCRYPT === 'true',
        trustServerCertificate: process.env.DB_TRUST_SERVER_CERT === 'true'
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

let _poolPromise = null;
let _dbConnected = false;

// Lazy initialization — connect() only triggered when poolPromise is accessed
function getPoolPromise() {
    if (!_poolPromise) {
        _poolPromise = new sql.ConnectionPool(dbConfig)
            .connect()
            .then(pool => {
                _dbConnected = true;
                console.log('✅ Connected to SQL Server database:', process.env.DB_NAME);
                return pool;
            })
            .catch(err => {
                _dbConnected = false;
                // Reset the cached promise so the NEXT request retries the connection.
                // Without this, a single bad moment at startup would keep every API call
                // failing (with a confusing "null pool" error) until the process restarts.
                _poolPromise = null;
                console.error('❌ Database connection failed — the web server keeps running and will retry on the next request.');
                console.error(`   Target  : ${dbConfig.server}:${dbConfig.port}  database: ${dbConfig.database}  user: ${dbConfig.user || '(not set)'}`);
                console.error('   Reason  : ' + err.message);
                return null;
            });
    }
    return _poolPromise;
}

module.exports = {
    sql,
    // Use a getter so require() does not trigger connect() — only await/then does
    get poolPromise() {
        return getPoolPromise();
    },
    dbConnected: () => _dbConnected
};
