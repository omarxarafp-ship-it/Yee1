-- إنشاء جدول المستخدمين
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    username VARCHAR(100),
    first_seen TIMESTAMP DEFAULT NOW(),
    last_activity TIMESTAMP DEFAULT NOW(),
    total_downloads INTEGER DEFAULT 0,
    spam_score INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

-- إنشاء جدول القائمة السوداء
CREATE TABLE IF NOT EXISTS blacklist (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    reason TEXT,
    blocked_at TIMESTAMP DEFAULT NOW()
);

-- إنشاء جدول التحميلات
CREATE TABLE IF NOT EXISTS downloads (
    id SERIAL PRIMARY KEY,
    user_phone VARCHAR(20) NOT NULL,
    app_id VARCHAR(255) NOT NULL,
    app_name VARCHAR(255),
    file_type VARCHAR(10),
    file_size BIGINT,
    created_at TIMESTAMP DEFAULT NOW(),
    downloaded_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (user_phone) REFERENCES users(phone_number) ON DELETE CASCADE
);

-- إنشاء فهارس لتحسين الأداء
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone_number);
CREATE INDEX IF NOT EXISTS idx_blacklist_phone ON blacklist(phone_number);
CREATE INDEX IF NOT EXISTS idx_downloads_user ON downloads(user_phone);
CREATE INDEX IF NOT EXISTS idx_downloads_date ON downloads(downloaded_at);
