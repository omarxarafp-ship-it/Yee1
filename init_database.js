
import pkg from 'pg';
const { Pool } = pkg;
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function initDatabase() {
    if (!process.env.DATABASE_URL) {
        console.log('⚠️  DATABASE_URL غير موجود - تخطي تهيئة قاعدة البيانات');
        return;
    }

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
    });

    try {
        console.log('🗄️  جاري تهيئة قاعدة البيانات...');
        
        const schemaPath = path.join(__dirname, 'database', 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        
        await pool.query(schema);
        
        console.log('✅ تم إنشاء جداول قاعدة البيانات بنجاح!');
    } catch (error) {
        console.error('❌ خطأ في تهيئة قاعدة البيانات:', error.message);
    } finally {
        await pool.end();
    }
}

initDatabase();
