-- Migration: 104_login_attempt_tracking.sql
-- Add login attempt tracking and account lockout system
-- Phase 1.5 of Authentication & Onboarding Implementation Plan
-- Progressive lockout: 5 attempts → 15min, 10 → 1hr, 15 → 24hr

-- Create login attempts table
CREATE TABLE IF NOT EXISTS login_attempts (
    id INT AUTO_INCREMENT PRIMARY KEY,

    -- Attempt identification
    email VARCHAR(255) NOT NULL,
    user_id INT NULL COMMENT 'Null if user not found',
    ip_address VARCHAR(45) NOT NULL,
    user_agent TEXT,

    -- Attempt details
    success BOOLEAN DEFAULT FALSE,
    failure_reason VARCHAR(100) COMMENT 'invalid_password, user_not_found, account_locked, etc',

    -- Location data (optional enhancement)
    country_code VARCHAR(2),
    city VARCHAR(100),

    -- Timestamps
    attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Indexes for performance
    INDEX idx_email (email),
    INDEX idx_user_id (user_id),
    INDEX idx_ip_address (ip_address),
    INDEX idx_attempted_at (attempted_at),
    INDEX idx_success (success),
    INDEX idx_email_ip_time (email, ip_address, attempted_at),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Track all login attempts (success and failure) for security monitoring and brute force protection.';

-- Add lockout columns to users table
SET @col_exists_failed_attempts = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'failed_login_attempts');

SET @sql_failed_attempts = IF(@col_exists_failed_attempts = 0,
    'ALTER TABLE users ADD COLUMN failed_login_attempts INT DEFAULT 0 AFTER token_version',
    'SELECT "failed_login_attempts column already exists" AS message');
PREPARE stmt FROM @sql_failed_attempts;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists_locked_until = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'account_locked_until');

SET @sql_locked_until = IF(@col_exists_locked_until = 0,
    'ALTER TABLE users ADD COLUMN account_locked_until TIMESTAMP NULL AFTER failed_login_attempts',
    'SELECT "account_locked_until column already exists" AS message');
PREPARE stmt FROM @sql_locked_until;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists_last_failed_login = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'last_failed_login_at');

SET @sql_last_failed_login = IF(@col_exists_last_failed_login = 0,
    'ALTER TABLE users ADD COLUMN last_failed_login_at TIMESTAMP NULL AFTER account_locked_until',
    'SELECT "last_failed_login_at column already exists" AS message');
PREPARE stmt FROM @sql_last_failed_login;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Create index for efficient lockout checks
CREATE INDEX idx_lockout_status ON users(email, account_locked_until, failed_login_attempts);

-- Add comment for documentation
ALTER TABLE login_attempts
COMMENT = 'Login attempt tracking for brute force protection. Progressive lockout: 5 fails=15min, 10=1hr, 15=24hr.';
